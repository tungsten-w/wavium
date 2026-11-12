<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Activity;

use OCA\DailyTodo\Service\ActivityPublisher;
use OCP\Activity\Exceptions\UnknownActivityException;
use OCP\Activity\IEvent;
use OCP\Activity\IEventMerger;
use OCP\Activity\IProvider;
use OCP\IURLGenerator;
use OCP\IUserManager;
use OCP\L10N\IFactory;

/** Turns the stored events into the sentences the Activity app shows, in the viewer's language. */
final class Provider implements IProvider
{
    public function __construct(private IFactory $languages, private IURLGenerator $urls, private IUserManager $users, private IEventMerger $merger) {}

    public function parse($language, IEvent $event, ?IEvent $previousEvent = null): IEvent
    {
        if ($event->getApp() !== ActivityPublisher::APP) {
            throw new UnknownActivityException();
        }
        $l = $this->languages->get(ActivityPublisher::APP, $language);
        $p = $event->getSubjectParameters();
        $viewer = $event->getAffectedUser();
        $mine = ($p['actor'] ?? '') === $viewer;
        $shared = ($p['owner'] ?? '') !== ($p['actor'] ?? '');
        $item = ['type' => 'highlight', 'id' => '0', 'name' => (string) ($p['title'] ?? '')];
        $params = ['item' => $item];
        if (!$mine) {
            $params['actor'] = $this->user((string) ($p['actor'] ?? ''));
        }
        if ($mine && $shared) {
            $params['owner'] = $this->user((string) ($p['owner'] ?? ''));
        }

        switch ($event->getSubject()) {
            case 'item_added':
                $subject = $mine ? ($shared ? $l->t('You added {item} to the list of {owner}') : $l->t('You added {item}')) : $l->t('{actor} added {item} to your list');
                break;
            case 'item_done':
                $subject = $mine ? ($shared ? $l->t('You completed {item} on the list of {owner}') : $l->t('You completed {item}')) : $l->t('{actor} completed {item} on your list');
                break;
            case 'item_deleted':
                $subject = $mine ? ($shared ? $l->t('You deleted {item} from the list of {owner}') : $l->t('You deleted {item}')) : $l->t('{actor} deleted {item} from your list');
                break;
            case 'item_restored':
                $subject = $mine ? ($shared ? $l->t('You brought back {item} on the list of {owner}') : $l->t('You brought back {item}')) : $l->t('{actor} brought back {item} on your list');
                break;
            case 'item_postponed':
                $due = (string) ($p['due'] ?? '');
                $params['date'] = ['type' => 'highlight', 'id' => $due, 'name' => $this->date($due, $language)];
                $subject = $mine ? ($shared ? $l->t('You postponed {item} on the list of {owner} to {date}') : $l->t('You postponed {item} to {date}')) : $l->t('{actor} postponed {item} to {date}');
                break;
            case 'day_finished':
                $day = (string) ($p['day'] ?? '');
                $params['date'] = ['type' => 'highlight', 'id' => $day, 'name' => $this->date($day, $language)];
                unset($params['item']);
                $subject = $mine ? ($shared ? $l->t('You finished everything on the list of {owner} for {date}') : $l->t('You finished everything for {date}')) : $l->t('{actor} finished everything on your list for {date}');
                break;
            case 'list_shared':
                unset($params['item']);
                $params['actor'] = $this->user((string) ($p['actor'] ?? ''));
                $subject = $l->t('{actor} shared a Daily Todo list with you');
                break;
            default:
                throw new UnknownActivityException();
        }

        $event->setRichSubject($subject, $params);
        $event->setParsedSubject(self::plain($subject, $params));
        $event->setIcon($this->urls->imagePath(ActivityPublisher::APP, 'app-dark.svg'));
        $event->setLink($this->urls->linkToRouteAbsolute('daily_todo.page.index'));

        // A run of completions (or additions) becomes one line: "You completed A, B and C".
        if (in_array($event->getSubject(), ['item_done', 'item_added'], true)) {
            return $this->merger->mergeEvents('item', $event, $previousEvent);
        }

        return $event;
    }

    /** @return array{type: string, id: string, name: string} */
    private function user(string $uid): array
    {
        return ['type' => 'user', 'id' => $uid, 'name' => $this->users->getDisplayName($uid) ?? $uid];
    }

    private function date(string $day, string $language): string
    {
        $time = strtotime($day . ' 12:00:00');
        if ($time === false) {
            return $day;
        }

        return (new \IntlDateFormatter($language, \IntlDateFormatter::MEDIUM, \IntlDateFormatter::NONE))->format($time) ?: $day;
    }

    /** The sentence without markup, for clients that do not render rich subjects. */
    private static function plain(string $subject, array $params): string
    {
        $replace = [];
        foreach ($params as $key => $value) {
            $replace['{' . $key . '}'] = $value['name'];
        }

        return strtr($subject, $replace);
    }
}
