<?php
declare(strict_types=1);

// Real DAV and DB fixtures only; all changes are rolled back.
require '/var/www/html/lib/base.php';

use OCA\DailyTodo\Service\BoardService;
use OCA\DailyTodo\Service\LogicalDate;

$db = \OC::$server->get(\OCP\IDBConnection::class);
$service = \OC::$server->get(BoardService::class);
$backend = \OC::$server->get(\OCA\DAV\CalDAV\CalDavBackend::class);
$uid = 'daily-todo-trash-' . bin2hex(random_bytes(6));
$check = static function (bool $ok, string $name): void {
    if (!$ok) throw new RuntimeException($name);
    echo "PASS $name\n";
};
$db->beginTransaction();
try {
    $board = $service->accessibleBoard($uid);
    $today = LogicalDate::forTimestamp(time(), $board['timezone'], (int) $board['rollover_hour']);
    $service->saveTemplate($uid, [['title' => 'Morning'], ['title' => '__DAY_ITEMS__'], ['title' => 'Evening']]);
    $calendar = $backend->createCalendar('principals/users/' . $uid, 'trash-fixture', [
        '{DAV:}displayname' => 'Temporary trash fixture',
        '{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set' => new \Sabre\CalDAV\Xml\Property\SupportedCalendarComponentSet(['VTODO']),
    ]);
    $originals = [];
    foreach (['root' => '', 'child' => "RELATED-TO:root\r\n", 'grandchild' => "RELATED-TO:child\r\n", 'unrelated' => ''] as $name => $extra) {
        $data = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Trash test//EN\r\nBEGIN:VTODO\r\nUID:$name\r\nSUMMARY:$name\r\nDTSTART;VALUE=DATE:" . str_replace('-', '', $today) . "\r\nDESCRIPTION:Keep my notes\r\nPRIORITY:3\r\n" . $extra . "END:VTODO\r\nEND:VCALENDAR\r\n";
        $backend->createCalendarObject($calendar, $name . '.ics', $data);
        $originals[$name] = $backend->getCalendarObject($calendar, $name . '.ics')['calendardata'];
    }
    $settings = $service->settings($uid);
    $settings['taskLists'] = [(string) $calendar];
    $service->saveSettings($uid, $settings);
    $items = array_column($service->getDay($uid, $today)['items'], null, 'title');
    $quick = $service->createQuick($uid, $today, 'Quick child', null, $items['root']['id']);
    $version = $service->getDay($uid, $today)['version'];
    $trash = $service->deleteQuick($uid, $items['root']['id']);
    $after = $service->getDay($uid, $today);
    $check($after['version'] !== $version, 'task deletion changes the live sync fingerprint');
    $titles = array_column($after['items'], 'title');
    $check(!array_intersect(['root', 'child', 'grandchild', 'Quick child'], $titles), 'task and quick descendants leave the daily list');
    $check(in_array('unrelated', $titles, true) && in_array('Morning', $titles, true), 'unrelated tasks and routines remain');
    $active = static function (string $name) use ($db, $calendar): bool {
        $q = $db->getQueryBuilder();
        $q->select('id')->from('calendarobjects')->where($q->expr()->eq('calendarid', $q->createNamedParameter($calendar)))
            ->andWhere($q->expr()->eq('uri', $q->createNamedParameter($name . '.ics')))->andWhere($q->expr()->isNull('deleted_at'));
        return $q->executeQuery()->fetchOne() !== false;
    };
    foreach (['root', 'child', 'grandchild'] as $name) $check(!$active($name), "$name is removed from Tasks too");
    $service->resetDay($uid, $today);
    $check(!in_array('root', array_column($service->getDay($uid, $today)['items'], 'title'), true), 'regeneration does not resurrect deleted Tasks');
    try {
        $service->restore($uid . '-stranger', $trash);
        throw new RuntimeException('unauthorized restore succeeded');
    } catch (RuntimeException $error) {
        $check($error->getMessage() !== 'unauthorized restore succeeded', 'another user cannot restore this task');
    }
    $service->restore($uid, $trash);
    $items = array_column($service->getDay($uid, $today)['items'], null, 'title');
    foreach (['root', 'child', 'grandchild'] as $name) {
        $check($active($name), "$name is restored in Tasks");
        $check($backend->getCalendarObject($calendar, $name . '.ics')['calendardata'] === $originals[$name], "$name keeps its exact VTODO on Undo");
    }
    $check($items['child']['parent_id'] === $items['root']['id'] && $items['Quick child']['parent_id'] === $items['root']['id'], 'Undo restores task and quick-child nesting');
    // Deleting a subtask must not delete its parent or siblings.
    $trash = $service->deleteQuick($uid, $items['child']['id']);
    $check($active('root') && !$active('child') && !$active('grandchild') && $active('unrelated'), 'deleting a subtask only trashes its own subtree');
    $service->restore($uid, $trash, true);
    $items = array_column($service->getDay($uid, $today)['items'], null, 'title');
    $check($items['child']['parent_id'] === $items['root']['id'], 'Restore to today preserves a subtask parent');
    $trash = $service->deleteQuick($uid, $items['root']['id']);
    // URI reuse is a real restore conflict: never overwrite the replacement.
    $replacement = str_replace('UID:root', 'UID:replacement', $originals['root']);
    $backend->createCalendarObject($calendar, 'root.ics', $replacement);
    try {
        $service->restore($uid, $trash);
        throw new RuntimeException('conflicting restore succeeded');
    } catch (Throwable $error) {
        $check($error->getMessage() !== 'conflicting restore succeeded', 'restore refuses to overwrite a replacement Task');
    }
    $check(in_array($trash, array_column($service->trashList($uid), 'id'), true), 'failed restore preserves the Undo copy');
    $check(!$active('child') && !$active('grandchild'), 'failed restore rolls back the entire subtree');
    $backend->deleteCalendarObject($calendar, 'root.ics', 0, true);
    $service->restore($uid, $trash, true);
    $titles = array_column($service->getDay($uid, $today)['items'], 'title');
    $check($titles[0] === 'Morning' && end($titles) === 'Evening', 'Restore to today stays inside the Day items slot');
    $items = array_column($service->getDay($uid, $today)['items'], null, 'title');
    $trash = $service->deleteQuick($uid, $items['child']['id']);
    foreach (['child', 'grandchild'] as $name) $backend->deleteCalendarObject($calendar, $name . '-deleted.ics', 0, true);
    $service->restore($uid, $trash);
    foreach (['child', 'grandchild'] as $name) {
        $check($active($name) && $backend->getCalendarObject($calendar, $name . '.ics')['calendardata'] === $originals[$name], "$name restores from our snapshot even if DAV trash was purged");
    }
    $items = array_column($service->getDay($uid, $today)['items'], null, 'title');
    try {
        $service->deleteQuick($uid, $items['Morning']['id']);
        throw new RuntimeException('routine deletion succeeded');
    } catch (RuntimeException $error) {
        $check($error->getMessage() !== 'routine deletion succeeded', 'routine deletion remains forbidden');
    }
} catch (Throwable $error) {
    fwrite(STDERR, 'FAIL ' . $error->getMessage() . "\n" . $error->getTraceAsString() . "\n");
    $failed = true;
} finally {
    $db->rollBack();
    echo "All fixture changes rolled back\n";
}
exit(isset($failed) ? 1 : 0);
