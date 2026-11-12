<?php
declare(strict_types=1);

// Integration test: run in the app container. Calendar and checklist fixtures roll back.
require '/var/www/html/lib/base.php';

use OCA\DailyTodo\Service\BoardService;
use OCA\DailyTodo\Service\LogicalDate;

$db = \OC::$server->get(\OCP\IDBConnection::class);
$service = \OC::$server->get(BoardService::class);
$backend = \OC::$server->get(\OCA\DAV\CalDAV\CalDavBackend::class);
$uid = 'daily-todo-insertion-test-' . bin2hex(random_bytes(6));
$check = static function (bool $ok, string $name): void {
    if (!$ok) throw new RuntimeException($name);
    echo "PASS $name\n";
};
$db->beginTransaction();
try {
    $board = $service->accessibleBoard($uid);
    $today = LogicalDate::forTimestamp(time(), $board['timezone'], (int) $board['rollover_hour']);
    $service->saveTemplate($uid, [['title' => 'Morning'], ['title' => '↳ Morning child'], ['title' => '__DAY_ITEMS__'], ['title' => 'Evening']]);
    $first = $service->createQuick($uid, $today, 'First');
    $items = $service->getDay($uid, $today)['items'];
    $check(array_column($items, 'title') === ['Morning', 'Morning child', 'First', 'Evening'], 'first API addition builds the day before inserting into its slot');
    $next = $service->createQuick($uid, $today, 'Next');
    $child = $service->createQuick($uid, $today, 'Child', null, $first);
    $items = $service->getDay($uid, $today)['items'];
    $check(array_column($items, 'title') === ['Morning', 'Morning child', 'First', 'Child', 'Next', 'Evening'], 'new subtask is stored immediately after its parent block');
    $check($items[3]['parent_id'] === $first, 'new subtask remains nested');
    $service->deleteQuick($uid, $next);
    $remaining = $service->getDay($uid, $today)['items'];
    $morning = $remaining[0]['id'];
    $morningChild = $remaining[1]['id'];
    $evening = $remaining[4]['id'];
    $service->reorder($uid, $today, [$first, $child, $morning, $morningChild, $evening]);
    $default = $service->createQuick($uid, $today, 'Default');
    $items = $service->getDay($uid, $today)['items'];
    $check(array_column($items, 'title') === ['First', 'Child', 'Morning', 'Morning child', 'Default', 'Evening'], 'a day item moved above morning does not pull new items out of the template slot');
    $service->createQuick($uid, $today, 'Explicit sibling', null, null, $first);
    $check(array_column($service->getDay($uid, $today)['items'], 'title') === ['First', 'Child', 'Explicit sibling', 'Morning', 'Morning child', 'Default', 'Evening'], 'explicit insertion after an item still follows its whole subtree');

    $calendar = $backend->createCalendar('principals/users/' . $uid, 'insertion-fixture', [
        '{DAV:}displayname' => 'Temporary insertion fixture',
        '{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set' => new \Sabre\CalDAV\Xml\Property\SupportedCalendarComponentSet(['VTODO', 'VEVENT']),
    ]);
    $settings = $service->settings($uid);
    $settings['taskLists'] = [(string) $calendar];
    $settings['calendars'] = [(string) $calendar];
    $service->saveSettings($uid, $settings);
    $date = str_replace('-', '', $today);
    $backend->createCalendarObject($calendar, 'task.ics', "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Insertion test//EN\r\nBEGIN:VTODO\r\nUID:insertion-task\r\nSUMMARY:Synced task\r\nDTSTART;VALUE=DATE:$date\r\nEND:VTODO\r\nEND:VCALENDAR\r\n");
    $backend->createCalendarObject($calendar, 'event.ics', "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Insertion test//EN\r\nBEGIN:VEVENT\r\nUID:insertion-event\r\nSUMMARY:Synced event\r\nDTSTART;VALUE=DATE:$date\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n");
    $items = $service->getDay($uid, $today)['items'];
    $check(array_column($items, 'title') === ['First', 'Child', 'Explicit sibling', 'Morning', 'Morning child', 'Default', 'Synced event', 'Synced task', 'Evening'], 'late Tasks and Calendar sources append inside the Day items slot');
    $check($service->getDay($uid, $today)['items'] === $items, 'reload preserves the insertion order');
    $trash = $service->postpone($uid, $default, 2);
    $service->restore($uid, $trash['trash'], true);
    $items = $service->getDay($uid, $today)['items'];
    $check(array_column($items, 'title') === ['First', 'Child', 'Explicit sibling', 'Morning', 'Morning child', 'Synced event', 'Synced task', 'Default', 'Evening'], 'restoring a postponed item to today uses the same slot');

    foreach ([
        'at beginning' => ['__DAY_ITEMS__', 'Evening'],
        'at end' => ['Morning', '__DAY_ITEMS__'],
        'without routines' => ['__DAY_ITEMS__'],
    ] as $name => $titles) {
        $actor = $uid . '-' . str_replace(' ', '-', $name);
        $service->saveTemplate($actor, array_map(static fn($title) => ['title' => $title], $titles));
        $service->createQuick($actor, $today, 'One');
        $service->createQuick($actor, $today, 'Two');
        $expected = [];
        foreach ($titles as $title) {
            array_push($expected, ...($title === '__DAY_ITEMS__' ? ['One', 'Two'] : [$title]));
        }
        $check(array_column($service->getDay($actor, $today)['items'], 'title') === $expected, 'template slot ' . $name . ' is respected on first and later additions');
    }
} catch (Throwable $error) {
    fwrite(STDERR, 'FAIL ' . $error->getMessage() . "\n");
    $failed = true;
} finally {
    $db->rollBack();
    echo "All fixture changes rolled back\n";
}
exit(isset($failed) ? 1 : 0);
