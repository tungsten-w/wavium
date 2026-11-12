<?php
declare(strict_types=1);

// Integration test: run inside the Nextcloud app container. All fixture data is rolled back.
require '/var/www/html/lib/base.php';

use OCA\DailyTodo\Service\BoardService;
use OCA\DailyTodo\Service\LogicalDate;

$db = \OC::$server->get(\OCP\IDBConnection::class);
$service = \OC::$server->get(BoardService::class);
$uid = 'daily-todo-rollover-test-' . bin2hex(random_bytes(6));
$check = static function (bool $ok, string $name): void {
    if (!$ok) throw new RuntimeException($name);
    echo "PASS $name\n";
};
$db->beginTransaction();
try {
    $board = $service->accessibleBoard($uid);
    $service->saveTemplate($uid, [['title' => 'Morning'], ['title' => '__DAY_ITEMS__'], ['title' => 'Evening']]);
    $today = LogicalDate::forTimestamp(time(), $board['timezone'], (int) $board['rollover_hour']);
    $yesterday = (new DateTimeImmutable($today))->modify('-1 day')->format('Y-m-d');
    $dayRow = new ReflectionMethod($service, 'dayRow');
    $previous = $dayRow->invoke($service, $board, $yesterday);
    $insert = new ReflectionMethod($service, 'insertItem');
    $parent = $insert->invoke($service, $previous['id'], ['source_type' => 'quick', 'source_id' => 'quick-parent', 'title' => 'Parent'], 0);
    $insert->invoke($service, $previous['id'], ['source_type' => 'quick', 'source_id' => 'quick-child', 'title' => 'Child'], 1, $parent);
    $insert->invoke($service, $previous['id'], ['source_type' => 'task', 'source_id' => 'fixture:task', 'title' => 'Task'], 2);
    $insert->invoke($service, $previous['id'], ['source_type' => 'quick', 'source_id' => 'done', 'title' => 'Done', 'completed' => true], 3);
    $insert->invoke($service, $previous['id'], ['source_type' => 'quick', 'source_id' => 'divider', 'title' => '---'], 4);
    $run = new ReflectionMethod($service, 'materializeBoard');
    $run->invoke($service, $board);
    $items = $service->getDay($uid, $today)['items'];
    $check(array_column($items, 'title') === ['Morning', 'Parent', 'Child', 'Task', 'Evening'], 'unfinished quick items and tasks occupy the Day items slot');
    $check($items[2]['parent_id'] === $items[1]['id'], 'carried subtasks retain their parent');
    $run->invoke($service, $board);
    $check($service->getDay($uid, $today)['items'] === $items, 'repeated materialization is idempotent');
    $postponed = $service->postpone($uid, $items[1]['id'], 3);
    $run->invoke($service, $board);
    $check(array_column($service->getDay($uid, $today)['items'], 'title') === ['Morning', 'Task', 'Evening'], 'postponed parent and child stay off today after cron');
    $check(count($service->trashList($uid)) === 1, 'postponed copy waits for its selected day');
    $service->restore($uid, $postponed['trash']);
    $run->invoke($service, $board);
    $restored = $service->getDay($uid, $today)['items'];
    $check(array_column($restored, 'title') === ['Morning', 'Parent', 'Child', 'Task', 'Evening'], 'undo restores position and nesting without duplicate rollover');
    $service->deleteQuick($uid, $restored[1]['id']);
    $run->invoke($service, $board);
    $check(array_column($service->getDay($uid, $today)['items'], 'title') === ['Morning', 'Task', 'Evening'], 'deleted carried items stay deleted after cron');
    $check($service->getDay($uid, (new DateTimeImmutable($today))->modify('+3 days')->format('Y-m-d'))['items'] === [], 'postponing never creates a future day');
} catch (Throwable $error) {
    fwrite(STDERR, 'FAIL ' . $error->getMessage() . "\n");
    $failed = true;
} finally {
    $db->rollBack();
    echo "All fixture changes rolled back\n";
}
exit(isset($failed) ? 1 : 0);
