<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Search;

use OCA\DailyTodo\AppInfo\Application;
use OCP\DB\QueryBuilder\IQueryBuilder;
use OCP\IDBConnection;
use OCP\IL10N;
use OCP\IURLGenerator;
use OCP\IUser;
use OCP\Search\IProvider;
use OCP\Search\ISearchQuery;
use OCP\Search\SearchResult;
use OCP\Search\SearchResultEntry;

/**
 * Nextcloud's top search bar: finds your items (own, tasks and events) across every recorded
 * day. An item that came back day after day (rolled over) is one result, with the last day
 * it was on, and opens that day. Routines are left out: they are on every day.
 */
final class SearchProvider implements IProvider
{
    public function __construct(private IDBConnection $db, private IL10N $l, private IURLGenerator $urls) {}

    public function getId(): string
    {
        return Application::APP_ID;
    }

    public function getName(): string
    {
        return $this->l->t('Daily Todo');
    }

    public function getOrder(string $route, array $routeParameters): ?int
    {
        return $route === 'daily_todo.page.index' ? -1 : 55;
    }

    public function search(IUser $user, ISearchQuery $query): SearchResult
    {
        $term = trim($query->getTerm());
        $offset = max(0, (int) $query->getCursor());
        if (mb_strlen($term) < 2) {
            return SearchResult::complete($this->getName(), []);
        }

        $q = $this->db->getQueryBuilder();
        $q->select('i.title')
            ->selectAlias($q->createFunction('MAX(d.day)'), 'last_day')
            ->selectAlias($q->createFunction('COUNT(DISTINCT d.day)'), 'days')
            ->from('daily_todo_items', 'i')
            ->innerJoin('i', 'daily_todo_days', 'd', $q->expr()->eq('d.id', 'i.day_id'))
            ->innerJoin('d', 'daily_todo_boards', 'b', $q->expr()->eq('b.id', 'd.board_id'))
            ->where($q->expr()->eq('b.owner_uid', $q->createNamedParameter($user->getUID())))
            ->andWhere($q->expr()->in('i.source_type', $q->createNamedParameter(['quick', 'task', 'event'], IQueryBuilder::PARAM_STR_ARRAY)))
            ->andWhere($q->expr()->iLike('i.title', $q->createNamedParameter('%' . $this->db->escapeLikeParameter($term) . '%')))
            ->andWhere($q->expr()->notIn('i.title', $q->createNamedParameter(['---', '___', '<br>', '<br/>', '<br />'], IQueryBuilder::PARAM_STR_ARRAY)))
            ->groupBy('i.title')
            ->orderBy('last_day', 'DESC')
            ->addOrderBy('i.title', 'ASC')
            ->setFirstResult($offset)
            ->setMaxResults($query->getLimit());

        $entries = [];
        $rows = $q->executeQuery()->fetchAllAssociative();
        foreach ($rows as $row) {
            $day = (string) $row['last_day'];
            $days = (int) $row['days'];
            $date = $this->l->l('date', new \DateTimeImmutable($day), ['width' => 'medium']);
            $entries[] = new SearchResultEntry(
                '',
                (string) $row['title'],
                $days > 1 ? $this->l->t('%d days, last on %s', [$days, $date]) : $date,
                $this->urls->linkToRouteAbsolute('daily_todo.page.index') . '#day/' . $day,
                'icon-checkmark',
            );
        }

        return count($rows) >= $query->getLimit()
            ? SearchResult::paginated($this->getName(), $entries, $offset + count($rows))
            : SearchResult::complete($this->getName(), $entries);
    }
}
