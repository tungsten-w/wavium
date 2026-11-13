<?php
declare(strict_types=1);

// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Atrium agent layer (P3-1): todo.* events queued by BoardService, and the
// internal controller the agent tools call. Real DB; everything rolled back.
require '/var/www/html/lib/base.php';

// Nextcloud's error handler logs a fatal error and exits 0: make any failure loud.
set_exception_handler(static function (\Throwable $e): void {
    fwrite(STDERR, 'FAIL ' . get_class($e) . ': ' . $e->getMessage() . ' at ' . $e->getFile() . ':' . $e->getLine() . "\n");
    exit(1);
});

use OC\Agent\InternalAuth;
use OCA\DailyTodo\Controller\AtriumAgentController;
use OCA\DailyTodo\Service\AgentEvents;
use OCA\DailyTodo\Service\BoardService;
use OCA\DailyTodo\Service\LogicalDate;

$db = \OC::$server->get(\OCP\IDBConnection::class);
$uid = 'daily-todo-agent-' . bin2hex(random_bytes(6));
$check = static function (bool $ok, string $name): void {
    if (!$ok) throw new RuntimeException($name);
    echo "PASS $name\n";
};
$table = \OCP\Server::get(\OCP\IConfig::class)->getSystemValueString('dbtableprefix', 'oc_') . 'atrium_agent_event_queue';
$queued = static function () use ($db, $uid): array {
    $q = $db->getQueryBuilder();
    $rows = $q->select('*')->from('atrium_agent_event_queue')->where($q->expr()->eq('grantor_uid', $q->createNamedParameter($uid)))->orderBy('id')->executeQuery()->fetchAllAssociative();
    return array_map(static fn($r) => ['type' => $r['type'], 'area' => $r['area'], 'data' => json_decode($r['data'], true)], $rows);
};
$request = static function (bool $internal): \OCP\IRequest {
    $server = $internal ? ['HTTP_X_ATRIUM_INTERNAL' => \OCP\Server::get(InternalAuth::class)->expected()] : [];
    return new \OC\AppFramework\Http\Request(['server' => $server], \OCP\Server::get(\OCP\IRequestId::class), \OCP\Server::get(\OCP\IConfig::class));
};

// Without the agent layer's table, nothing is queued and nothing breaks.
$hadTable = $db->tableExists('atrium_agent_event_queue');
if (!$hadTable) {
    $events = new AgentEvents($db, \OCP\Server::get(\Psr\Log\LoggerInterface::class));
    $events->emit('todo.item.created', $uid, $uid, ['item_id' => 1]);
    $check(true, 'no queue table: emit is a no-op');
}

$db->beginTransaction();
try {
    if (!$hadTable) {
        // Same columns as server/agent/db.ts (the agent layer creates it on the real instance).
        $db->executeStatement("CREATE TABLE $table (id BIGSERIAL PRIMARY KEY, dedupe_key VARCHAR(200), app VARCHAR(64) NOT NULL, area VARCHAR(64) NOT NULL, type VARCHAR(100) NOT NULL, grantor_uid VARCHAR(64) NOT NULL, agent_uid VARCHAR(64), wake_hint SMALLINT NOT NULL DEFAULT 0, data TEXT NOT NULL, created_at BIGINT NOT NULL)");
    }
    // Fresh services: the DI copies may have cached "no table".
    $events = new AgentEvents($db, \OCP\Server::get(\Psr\Log\LoggerInterface::class));
    $service = new BoardService($db, \OCP\Server::get(\OCP\IGroupManager::class), \OCP\Server::get(\OCA\DailyTodo\Service\CalDavAdapter::class), \OCP\Server::get(\OCP\IUserManager::class), \OCP\Server::get(\OCA\DailyTodo\Service\ActivityPublisher::class), $events);

    $board = $service->accessibleBoard($uid);
    $today = LogicalDate::forTimestamp(time(), $board['timezone'], (int) $board['rollover_hour']);
    $service->saveTemplate($uid, [['title' => 'Morning'], ['title' => '__DAY_ITEMS__'], ['title' => '---'], ['title' => 'Evening']]);
    $service->getDay($uid, $today);

    // --- BoardService changes become todo.* events (web UI path: no agent)
    $a = $service->createQuick($uid, $today, 'Buy bread');
    $b = $service->createQuick($uid, $today, 'Call Bob');
    $service->complete($uid, $a, true);
    $service->complete($uid, $a, true); // already done: no second event
    $service->complete($uid, $a, false);
    $service->rename($uid, $b, 'Call Bob back');
    $ids = array_map(static fn($i) => (int) $i['id'], $service->getDay($uid, $today)['items']);
    $service->reorder($uid, $today, array_reverse($ids));
    $trash = $service->deleteQuick($uid, $b);
    $service->restore($uid, $trash);
    $p = $service->postpone($uid, $a, 2);
    $rows = $queued();
    $check(array_column($rows, 'type') === [
        'todo.item.created', 'todo.item.created', 'todo.item.completed', 'todo.item.uncompleted', 'todo.item.renamed',
        'todo.day.reordered', 'todo.item.deleted', 'todo.item.restored', 'todo.item.postponed',
    ], 'every change queues one todo.* event, in order: ' . implode(',', array_column($rows, 'type')));
    $check(array_unique(array_column($rows, 'area')) === ['daily_todo'], 'area is daily_todo (the grant area)');
    $check($rows[0]['data'] === ['actor' => $uid, 'item_id' => $a, 'day' => $today, 'title' => 'Buy bread', 'kind' => 'quick', 'parent_id' => null], 'created event data');
    $check($rows[4]['data']['old_title'] === 'Call Bob' && $rows[4]['data']['title'] === 'Call Bob back', 'renamed event keeps the old title');
    $check($rows[6]['data']['trash_id'] === $trash && $rows[8]['data']['due'] === $p['due'], 'deleted/postponed events carry the undo id and the due day');
    $check(!isset($rows[0]['data']['agent']), 'no agent field for a change made in the UI');

    // --- the internal controller: refused without the header, acts as uid, names the agent
    $outside = new AtriumAgentController($request(false), $service, $events, \OCP\Server::get(\Psr\Log\LoggerInterface::class));
    $check($outside->call('day', $uid)->getStatus() === 403, 'controller refuses calls without X-Atrium-Internal');
    $ctl = new AtriumAgentController($request(true), $service, $events, \OCP\Server::get(\Psr\Log\LoggerInterface::class));
    $check($ctl->call('today', $uid)->getData() === ['day' => $today], 'today = the board\'s logical day');
    $res = $ctl->call('create', $uid, 'nova', ['title' => 'From the agent']);
    $new = (int) $res->getData()['id'];
    $check($res->getStatus() === 200 && $new > 0, 'create through the controller');
    $last = $queued()[count($queued()) - 1];
    $check($last['type'] === 'todo.item.created' && $last['data']['agent'] === 'nova' && $last['data']['actor'] === $uid, 'agent call: event names the agent, actor is the grantor');
    $day = $ctl->call('day', $uid, 'nova', ['date' => 'today'])->getData();
    $check(in_array('From the agent', array_column($day['items'], 'title'), true), 'day through the controller shows the new item');
    $check($ctl->call('complete', $uid, 'nova', ['item_id' => $new])->getData() === ['ok' => true], 'complete through the controller');
    $after = $ctl->call('create', $uid, null, ['title' => 'Plain'])->getStatus() === 200 ? $queued() : [];
    $check(!isset($after[count($after) - 1]['data']['agent']), 'the agent name does not stick to the next call');
    $check($ctl->call('rename', $uid, 'nova', ['item_id' => 99999999, 'title' => 'x'])->getStatus() === 404, 'unknown item: 404');
    $check($ctl->call('create', $uid, 'nova', [])->getStatus() === 400, 'missing title: 400');
    $check($ctl->call('day', $uid, 'nova', ['date' => '13/11/2026'])->getStatus() === 400, 'bad date: 400');
    $check($ctl->call('nope', $uid)->getStatus() === 400, 'unknown operation: 400');
    $event = array_values(array_filter($day['items'], static fn($i) => $i['title'] === '---'))[0] ?? null;
    if ($event !== null) {
        $check($ctl->call('delete', $uid, 'nova', ['item_id' => (int) $event['id']])->getStatus() === 409, 'a routine row cannot be deleted: 409');
    }
    $check($ctl->call('day', 'someone-else-' . $uid, 'nova', ['date' => 'today'])->getStatus() === 200, 'another uid gets its own board (the agent layer checked the grant)');
} finally {
    $db->rollBack();
}
echo "OK agent\n";
