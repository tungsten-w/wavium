<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

final class Version1000Date20260930000000 extends SimpleMigrationStep
{
    public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper
    {
        $s = $schemaClosure();
        if (!$s->hasTable('daily_todo_boards')) {
            $t = $s->createTable('daily_todo_boards');
            $t->addColumn('id', 'bigint', ['autoincrement' => true,'notnull' => true]);
            $t->addColumn('owner_uid', 'string', ['length' => 64]);
            $t->addColumn('timezone', 'string', ['length' => 64,'default' => 'UTC']);
            $t->addColumn('rollover_hour', 'integer', ['default' => 3]);
            $t->addColumn('rollover_mode', 'string', ['length' => 16,'default' => 'quick_only']);
            $t->addColumn('task_lists', 'text', ['default' => '[]']);
            $t->addColumn('calendars', 'text', ['default' => '[]']);
            $t->setPrimaryKey(['id']);
            $t->addUniqueIndex(['owner_uid'], 'dt_owner');
        }
        if (!$s->hasTable('daily_todo_templates')) {
            $t = $s->createTable('daily_todo_templates');
            $t->addColumn('id', 'bigint', ['autoincrement' => true]);
            $t->addColumn('board_id', 'bigint');
            $t->addColumn('title', 'string', ['length' => 255]);
            $t->addColumn('position', 'integer');
            $t->setPrimaryKey(['id']);
            $t->addIndex(['board_id'], 'dt_tpl_board');
        }
        if (!$s->hasTable('daily_todo_days')) {
            $t = $s->createTable('daily_todo_days');
            $t->addColumn('id', 'bigint', ['autoincrement' => true]);
            $t->addColumn('board_id', 'bigint');
            $t->addColumn('day', 'string', ['length' => 10]);
            $t->addColumn('frozen', 'boolean', ['default' => false]);
            $t->addColumn('updated_at', 'bigint', ['default' => 0]);
            $t->setPrimaryKey(['id']);
            $t->addUniqueIndex(['board_id','day'], 'dt_board_day');
        }
        if (!$s->hasTable('daily_todo_items')) {
            $t = $s->createTable('daily_todo_items');
            $t->addColumn('id', 'bigint', ['autoincrement' => true]);
            $t->addColumn('day_id', 'bigint');
            $t->addColumn('source_type', 'string', ['length' => 16]);
            $t->addColumn('source_id', 'string', ['length' => 255,'notnull' => false]);
            $t->addColumn('title', 'string', ['length' => 255]);
            $t->addColumn('starts_at', 'bigint', ['notnull' => false]);
            $t->addColumn('due_at', 'bigint', ['notnull' => false]);
            $t->addColumn('all_day', 'boolean', ['default' => false]);
            $t->addColumn('completed', 'boolean', ['default' => false]);
            $t->addColumn('position', 'integer', ['default' => 0]);
            $t->addColumn('href', 'string', ['length' => 1024,'notnull' => false]);
            $t->addColumn('error', 'string', ['length' => 1024,'notnull' => false]);
            $t->setPrimaryKey(['id']);
            $t->addIndex(['day_id','position'], 'dt_item_day');
            $t->addUniqueIndex(['day_id','source_type','source_id'], 'dt_item_source');
        }
        if (!$s->hasTable('daily_todo_shares')) {
            $t = $s->createTable('daily_todo_shares');
            $t->addColumn('id', 'bigint', ['autoincrement' => true]);
            $t->addColumn('board_id', 'bigint');
            $t->addColumn('share_type', 'string', ['length' => 8]);
            $t->addColumn('share_with','string',['length' => 64]);
            $t->setPrimaryKey(['id']);
            $t->addUniqueIndex(['board_id','share_type','share_with'],'dt_share');
        }
        return $s;
    }
}
