<?php

declare(strict_types=1);

// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace OCA\DailyTodo\Service;

use OCP\IDBConnection;
use Psr\Log\LoggerInterface;

/**
 * Daily Todo changes as Atrium agent events (`todo.*`, ADR 0006 / 0009).
 *
 * Every change made through BoardService (web UI, API or an agent) is queued in
 * `atrium_agent_event_queue`; the agent layer (server/agent/events.ts) moves
 * queued rows into the event log that agents read with `events_since`. The
 * grantor is the board owner: an agent sees the event only with `daily_todo` read
 * access on that owner's data.
 *
 * Without the agent layer (the table does not exist yet), or on any database
 * error, nothing is queued and the change itself goes on: events are never
 * worth breaking a user action for.
 */
final class AgentEvents
{
    /** Agent acting through the internal controller, written as `data.agent`. */
    private ?string $via = null;
    private ?bool $ready = null;

    public function __construct(private IDBConnection $db, private LoggerInterface $logger) {}

    /** Set by AtriumAgentController for the duration of one agent call. */
    public function actingAgent(?string $agentUid): void
    {
        $this->via = $agentUid;
    }

    /**
     * @param string $type  e.g. 'todo.item.created'
     * @param array<string, mixed> $data
     */
    public function emit(string $type, string $owner, string $actor, array $data): void
    {
        // Checked first, not caught after: on PostgreSQL a failed INSERT inside a
        // transaction (restore runs in one) would abort the whole transaction.
        try {
            $this->ready ??= $this->db->tableExists('atrium_agent_event_queue');
        } catch (\Throwable) {
            $this->ready = false;
        }
        if (!$this->ready) {
            return;
        }
        $data = ['actor' => $actor] + ($this->via !== null ? ['agent' => $this->via] : []) + $data;
        try {
            $json = json_encode($data, JSON_THROW_ON_ERROR | JSON_UNESCAPED_UNICODE);
            $q = $this->db->getQueryBuilder();
            $q->insert('atrium_agent_event_queue')->values([
                'app' => $q->createNamedParameter('daily_todo'),
                'area' => $q->createNamedParameter('daily_todo'),
                'type' => $q->createNamedParameter($type),
                'grantor_uid' => $q->createNamedParameter($owner),
                // No wake rule for Daily Todo yet (ADR 0009: apps without one never wake).
                'wake_hint' => $q->createNamedParameter(0, \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT),
                'data' => $q->createNamedParameter($json),
                'created_at' => $q->createNamedParameter(time(), \OCP\DB\QueryBuilder\IQueryBuilder::PARAM_INT),
            ]);
            $q->executeStatement();
        } catch (\Throwable $e) {
            $this->logger->debug('Daily Todo: agent event not queued: ' . $e->getMessage(), ['app' => 'daily_todo']);
        }
    }
}
