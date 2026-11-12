<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Service;

use OCP\Activity\IManager;
use Psr\Log\LoggerInterface;

/**
 * Writes Daily Todo events to Nextcloud's activity stream (shown by the Activity app).
 *
 * Published: items added, completed, deleted, postponed or restored, a day finished, a list
 * shared. Completions are merged into one line per run by the Provider ("You completed A, B
 * and C"); ticking a Tasks item is left to the Tasks (dav) event so it does not appear twice. When someone edits a list shared with them, both they and the owner
 * get the event. Publishing never breaks the action itself: a failure is only logged.
 */
final class ActivityPublisher
{
    public const APP = 'daily_todo';
    public const TYPE_ITEMS = 'daily_todo_items';
    public const TYPE_DAYS = 'daily_todo_days';
    public const TYPE_SHARING = 'daily_todo_sharing';

    public function __construct(private IManager $manager, private LoggerInterface $logger) {}

    public function itemAdded(string $actor, string $owner, string $title): void
    {
        $this->publish(self::TYPE_ITEMS, 'item_added', $actor, [$owner, $actor], ['actor' => $actor, 'owner' => $owner, 'title' => $title]);
    }

    public function itemCompleted(string $actor, string $owner, string $title): void
    {
        $this->publish(self::TYPE_ITEMS, 'item_done', $actor, [$owner, $actor], ['actor' => $actor, 'owner' => $owner, 'title' => $title]);
    }

    public function itemDeleted(string $actor, string $owner, string $title): void
    {
        $this->publish(self::TYPE_ITEMS, 'item_deleted', $actor, [$owner, $actor], ['actor' => $actor, 'owner' => $owner, 'title' => $title]);
    }

    public function itemPostponed(string $actor, string $owner, string $title, string $due): void
    {
        $this->publish(self::TYPE_ITEMS, 'item_postponed', $actor, [$owner, $actor], ['actor' => $actor, 'owner' => $owner, 'title' => $title, 'due' => $due]);
    }

    public function itemRestored(string $actor, string $owner, string $title): void
    {
        $this->publish(self::TYPE_ITEMS, 'item_restored', $actor, [$owner, $actor], ['actor' => $actor, 'owner' => $owner, 'title' => $title]);
    }

    public function dayFinished(string $actor, string $owner, string $day): void
    {
        $this->publish(self::TYPE_DAYS, 'day_finished', $actor, [$owner, $actor], ['actor' => $actor, 'owner' => $owner, 'day' => $day]);
    }

    /** Tell the people a list was shared with. @param list<string> $recipients */
    public function listShared(string $owner, array $recipients): void
    {
        $this->publish(self::TYPE_SHARING, 'list_shared', $owner, $recipients, ['actor' => $owner, 'owner' => $owner]);
    }

    /** @param list<string> $users who gets the event in their stream */
    private function publish(string $type, string $subject, string $author, array $users, array $params): void
    {
        foreach (array_unique($users) as $user) {
            try {
                $event = $this->manager->generateEvent();
                $event->setApp(self::APP)
                    ->setType($type)
                    ->setAuthor($author)
                    ->setAffectedUser($user)
                    ->setTimestamp(time())
                    ->setSubject($subject, $params)
                    ->setObject('daily_todo', 0);
                $this->manager->publish($event);
            } catch (\Throwable $error) {
                $this->logger->warning('Daily Todo could not publish an activity: ' . $error->getMessage(), ['app' => self::APP]);
            }
        }
    }
}
