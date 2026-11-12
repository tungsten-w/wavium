<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

final class Version1003Date20261003150000 extends SimpleMigrationStep
{
    public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper
    {
        $schema = $schemaClosure();
        if (!$schema->hasTable('daily_todo_boards')) {
            return null;
        }

        $table = $schema->getTable('daily_todo_boards');
        if ($table->hasColumn('complete_subtasks')) {
            return null;
        }

        // Whether ticking a task also ticks its subtasks. Off by default: they are independent.
        $table->addColumn('complete_subtasks', 'boolean', ['default' => false]);

        return $schema;
    }
}
