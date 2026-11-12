<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

final class Version1001Date20261003000000 extends SimpleMigrationStep
{
    public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper
    {
        $schema = $schemaClosure();
        if (!$schema->hasTable('daily_todo_items')) {
            return null;
        }

        $table = $schema->getTable('daily_todo_items');
        if ($table->hasColumn('parent_id')) {
            return null;
        }

        $table->addColumn('parent_id', 'bigint', ['notnull' => false]);
        $table->addIndex(['parent_id'], 'dt_item_parent');

        return $schema;
    }
}
