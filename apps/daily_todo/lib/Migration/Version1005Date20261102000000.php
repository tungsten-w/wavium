<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\IDBConnection;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

/**
 * The titles an owner exposes on the public status route live on the board with the other
 * settings. They were first a user preference (`daily_todo/public_items`); copy those over.
 */
final class Version1005Date20261102000000 extends SimpleMigrationStep
{
    public function __construct(private IDBConnection $db) {}

    public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper
    {
        $schema = $schemaClosure();
        $table = $schema->getTable('daily_todo_boards');
        if ($table->hasColumn('public_items')) {
            return null;
        }
        $table->addColumn('public_items', 'text', ['notnull' => false]);

        return $schema;
    }

    public function postSchemaChange(IOutput $output, Closure $schemaClosure, array $options): void
    {
        $q = $this->db->getQueryBuilder();
        $q->select('userid', 'configvalue')->from('preferences')
            ->where($q->expr()->eq('appid', $q->createNamedParameter('daily_todo')))
            ->andWhere($q->expr()->eq('configkey', $q->createNamedParameter('public_items')));
        foreach ($q->executeQuery()->fetchAllAssociative() as $row) {
            $u = $this->db->getQueryBuilder();
            $u->update('daily_todo_boards')
                ->set('public_items', $u->createNamedParameter((string) $row['configvalue']))
                ->where($u->expr()->eq('owner_uid', $u->createNamedParameter($row['userid'])))
                ->executeStatement();
        }
        $d = $this->db->getQueryBuilder();
        $d->delete('preferences')
            ->where($d->expr()->eq('appid', $d->createNamedParameter('daily_todo')))
            ->andWhere($d->expr()->eq('configkey', $d->createNamedParameter('public_items')))
            ->executeStatement();
    }
}
