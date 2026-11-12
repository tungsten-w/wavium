<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Migration;

use Closure;
use OCP\DB\ISchemaWrapper;
use OCP\Migration\IOutput;
use OCP\Migration\SimpleMigrationStep;

final class Version1002Date20261003120000 extends SimpleMigrationStep
{
    public function changeSchema(IOutput $output, Closure $schemaClosure, array $options): ?ISchemaWrapper
    {
        $schema = $schemaClosure();
        if (!$schema->hasTable('daily_todo_items')) {
            return null;
        }

        $table = $schema->getTable('daily_todo_items');
        if ($table->hasColumn('title_locked')) {
            return null;
        }

        // Set when a routine item is renamed for one day, so the template does not overwrite it.
        $table->addColumn('title_locked', 'boolean', ['default' => false]);

        return $schema;
    }
}
