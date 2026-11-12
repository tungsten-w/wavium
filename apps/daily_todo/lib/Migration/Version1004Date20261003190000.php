<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

final class Version1004Date20261003190000 extends SimpleMigrationStep
{
    public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper
    {
        $schema = $schemaClosure();
        if ($schema->hasTable('daily_todo_trash')) {
            return null;
        }

        // Items taken off a day, kept briefly so "Undo" can put them back. With `due_day` set
        // they were moved to that (future) day and are placed on it when it starts.
        $table = $schema->createTable('daily_todo_trash');
        $table->addColumn('id', 'bigint', ['autoincrement' => true, 'notnull' => true]);
        $table->addColumn('board_id', 'bigint');
        $table->addColumn('day', 'string', ['length' => 10]);
        $table->addColumn('due_day', 'string', ['length' => 10, 'notnull' => false]);
        $table->addColumn('payload', 'text');
        $table->addColumn('created_at', 'bigint', ['default' => 0]);
        $table->setPrimaryKey(['id']);
        $table->addIndex(['board_id', 'due_day'], 'dt_trash_board');

        return $schema;
    }
}
