<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Service;

/**
 * Pure helpers that turn flat source entries into a parent-before-children list.
 *
 * An entry points at its parent through `parent_key` (`source_type:source_id`).
 */
final class EntryTree
{
    public const SUB_ITEM_PREFIX = '↳';

    /**
     * Rows titled "---" are divider lines and "<br>" rows are blank gaps.
     * They are layout, not work: they have no checkbox and never roll over.
     *
     * @return 'rule'|'space'|null
     */
    public static function separator(string $title): ?string
    {
        return match (strtolower(trim($title))) {
            '---', '___' => 'rule',
            '<br>', '<br/>', '<br />' => 'space',
            default => null,
        };
    }

    public static function key(array $entry): string
    {
        return $entry['source_type'] . ':' . $entry['source_id'];
    }

    /**
     * Sort root entries chronologically (all-day, then timed, then untimed) and
     * place every child directly after its parent, keeping sibling order.
     * A child whose parent is not part of the list becomes a root.
     *
     * @param list<array<string, mixed>> $entries
     * @return list<array<string, mixed>>
     */
    public static function order(array $entries): array
    {
        $present = [];
        foreach ($entries as $entry) {
            $present[self::key($entry)] = true;
        }

        $roots = [];
        $children = [];
        foreach ($entries as $entry) {
            $parent = $entry['parent_key'] ?? null;
            if ($parent !== null && $parent !== self::key($entry) && isset($present[$parent])) {
                $children[$parent][] = $entry;
            } else {
                $entry['parent_key'] = null;
                $roots[] = $entry;
            }
        }

        usort($roots, static fn(array $a, array $b) => (self::rank($a) <=> self::rank($b))
            ?: (($a['starts_at'] ?? 0) <=> ($b['starts_at'] ?? 0)));

        $out = [];
        $seen = [];
        $walk = static function (array $entry) use (&$walk, &$out, &$seen, $children): void {
            $key = self::key($entry);
            if (isset($seen[$key])) {
                return;
            }
            $seen[$key] = true;
            $out[] = $entry;
            foreach ($children[$key] ?? [] as $child) {
                $walk($child);
            }
        };
        foreach ($roots as $root) {
            $walk($root);
        }
        // Entries caught in a parent cycle are unreachable from any root; keep them.
        foreach ($entries as $entry) {
            $walk($entry);
        }

        return $out;
    }

    private static function rank(array $entry): int
    {
        return $entry['all_day'] ? 0 : ($entry['starts_at'] ? 1 : 2);
    }

    /**
     * Routine template rows prefixed with "↳" are sub-items of the closest
     * preceding top-level row. Returns [title without prefix, is sub-item].
     *
     * @return array{0: string, 1: bool}
     */
    public static function splitSubItem(string $title): array
    {
        if (preg_match('/^\s*' . preg_quote(self::SUB_ITEM_PREFIX, '/') . '\s*(.*)$/su', $title, $m) === 1) {
            return [trim($m[1]), true];
        }

        return [trim($title), false];
    }
}
