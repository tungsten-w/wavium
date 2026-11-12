<?php
declare(strict_types=1);

// Real DB and DAV fixtures, all rolled back. Never use real tasks for these checks.
require '/var/www/html/lib/base.php';

use OCA\DailyTodo\Service\BoardService;
use OCA\DailyTodo\Service\LogicalDate;

$db = \OC::$server->get(\OCP\IDBConnection::class);
$service = \OC::$server->get(BoardService::class);
$backend = \OC::$server->get(\OCA\DAV\CalDAV\CalDavBackend::class);
$uid = 'daily-todo-regeneration-' . bin2hex(random_bytes(6));
$check = static function (bool $ok, string $name): void {
    if (!$ok) throw new RuntimeException($name);
    echo "PASS $name\n";
};
$db->beginTransaction();
try {
    $board = $service->accessibleBoard($uid);
    $today = LogicalDate::forTimestamp(time(), $board['timezone'], (int) $board['rollover_hour']);
    $yesterday = (new DateTimeImmutable($today))->modify('-1 day')->format('Y-m-d');
    $future = (new DateTimeImmutable($today))->modify('+3 days')->format('Y-m-d');
    $service->saveTemplate($uid, [['title' => 'Morning'], ['title' => '__DAY_ITEMS__'], ['title' => 'Evening']]);
    $calendar = $backend->createCalendar('principals/users/' . $uid, 'regeneration-fixture', [
        '{DAV:}displayname' => 'Temporary regeneration fixture',
        '{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set' => new \Sabre\CalDAV\Xml\Property\SupportedCalendarComponentSet(['VTODO']),
    ]);
    $addTask = static function (string $name, ?string $day, string $extra = '', string $dateField = 'DTSTART') use ($backend, $calendar): void {
        $date = $day === null ? '' : $dateField . ';VALUE=DATE:' . str_replace('-', '', $day) . "\r\n";
        $backend->createCalendarObject($calendar, $name . '.ics', "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Regeneration test//EN\r\nBEGIN:VTODO\r\nUID:$name\r\nSUMMARY:$name\r\n" . $date . $extra . "END:VTODO\r\nEND:VCALENDAR\r\n");
    };
    $addTask('Overdue root', $yesterday);
    $addTask('Future child', $future, "RELATED-TO:Overdue root\r\n");
    $addTask('Completed old', $yesterday, "STATUS:COMPLETED\r\n");
    $addTask('Cancelled old', $yesterday, "STATUS:CANCELLED\r\n");
    $addTask('Repeating old', $yesterday, "RRULE:FREQ=DAILY\r\n");
    $addTask('Due-only old', $yesterday, '', 'DUE');
    $addTask('Undated', null);
    $addTask('Future root', $future);
    $settings = $service->settings($uid);
    $settings['taskLists'] = [(string) $calendar];
    $service->saveSettings($uid, $settings);
    $board = $service->accessibleBoard($uid);
    $dayRow = new ReflectionMethod($service, 'dayRow');
    $previous = $dayRow->invoke($service, $board, $yesterday);
    $insert = new ReflectionMethod($service, 'insertItem');
    $parent = $insert->invoke($service, $previous['id'], ['source_type' => 'quick', 'source_id' => 'parent', 'title' => 'Carried parent'], 0);
    $insert->invoke($service, $previous['id'], ['source_type' => 'quick', 'source_id' => 'child', 'title' => 'Carried child'], 1, $parent);
    $insert->invoke($service, $previous['id'], ['source_type' => 'quick', 'source_id' => 'postponed', 'title' => 'Postponed quick'], 2);
    $insert->invoke($service, $previous['id'], ['source_type' => 'quick', 'source_id' => 'deleted', 'title' => 'Deleted quick'], 3);
    $insert->invoke($service, $previous['id'], ['source_type' => 'task', 'source_id' => $calendar . ':Completed old.ics', 'title' => 'Stale completed snapshot'], 4);
    (new ReflectionMethod($service, 'materializeBoard'))->invoke($service, $board);
    $items = $service->getDay($uid, $today)['items'];
    foreach ($items as $item) {
        if ($item['title'] === 'Postponed quick') $service->postpone($uid, $item['id'], 3);
        if ($item['title'] === 'Deleted quick') $service->deleteQuick($uid, $item['id']);
    }
    $sourceBefore = $backend->getCalendarObject($calendar, 'Overdue root.ics')['calendardata'];
    $service->resetDay($uid, $today);
    $items = $service->getDay($uid, $today)['items'];
    $titles = array_column($items, 'title');
    $check(in_array('Overdue root', $titles, true) && in_array('Due-only old', $titles, true), 'regeneration includes current unfinished overdue Tasks from enabled lists');
    $byTitle = array_column($items, null, 'title');
    $check($byTitle['Future child']['parent_id'] === $byTitle['Overdue root']['id'], 'an overdue task retains its subtask even when the child has a future date');
    $check($byTitle['Carried child']['parent_id'] === $byTitle['Carried parent']['id'], 'quick carryover and nesting survive regeneration after yesterday was frozen');
    foreach (['Completed old', 'Stale completed snapshot', 'Cancelled old', 'Repeating old', 'Undated', 'Future root', 'Postponed quick', 'Deleted quick'] as $excluded) {
        $check(!in_array($excluded, $titles, true), 'regeneration excludes ' . $excluded);
    }
    $check($titles[0] === 'Morning' && end($titles) === 'Evening', 'rebuilt items stay in the template Day items slot');
    $check($backend->getCalendarObject($calendar, 'Overdue root.ics')['calendardata'] === $sourceBefore, 'regeneration does not change dates or other Tasks data');
    $service->resetDay($uid, $today);
    $check(array_column($service->getDay($uid, $today)['items'], 'title') === $titles, 'repeated regeneration neither duplicates nor loses carryover');
    foreach (['quick_only', 'none'] as $mode) {
        $settings['rolloverMode'] = $mode;
        $service->saveSettings($uid, $settings);
        $service->resetDay($uid, $today);
        $titles = array_column($service->getDay($uid, $today)['items'], 'title');
        $check(!in_array('Overdue root', $titles, true), $mode . ' does not import overdue Tasks');
        $check(in_array('Carried parent', $titles, true) === ($mode === 'quick_only'), $mode . ' respects quick-item rollover');
    }
} catch (Throwable $error) {
    fwrite(STDERR, 'FAIL ' . $error->getMessage() . "\n");
    $failed = true;
} finally {
    $db->rollBack();
    echo "All fixture changes rolled back\n";
}
exit(isset($failed) ? 1 : 0);
