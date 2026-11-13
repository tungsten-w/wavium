<?php

declare(strict_types=1);

// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace OCA\DailyTodo\Controller;

use OC\Agent\InternalAuth;
use OCA\DailyTodo\Service\AgentEvents;
use OCA\DailyTodo\Service\BoardService;
use OCA\DailyTodo\Service\LogicalDate;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use Psr\Log\LoggerInterface;

/**
 * Daily Todo for the Atrium agent layer (server/agent/todo, P3-1).
 *
 * Internal only: the request must carry X-Atrium-Internal (InternalAuth), which only
 * the Bun server can send. The agent layer has already checked the agent's token and
 * its `daily_todo` grant for `uid` (the grantor); every call here acts as that user through
 * BoardService, so the app's own rules (editable days, item kinds) apply unchanged.
 * `agent` is the agent's uid, written into the todo.* events it causes.
 */
final class AtriumAgentController extends Controller
{
    public function __construct(
        IRequest $request,
        private BoardService $service,
        private AgentEvents $events,
        private LoggerInterface $logger,
    ) {
        parent::__construct('daily_todo', $request);
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function call(string $op, string $uid, ?string $agent = null, array $args = []): JSONResponse
    {
        if (!\OCP\Server::get(InternalAuth::class)->isInternal($this->request)) {
            return new JSONResponse(['message' => 'internal only'], Http::STATUS_FORBIDDEN);
        }
        if ($uid === '') {
            return new JSONResponse(['message' => 'uid is required'], Http::STATUS_BAD_REQUEST);
        }
        $this->events->actingAgent($agent);
        try {
            return new JSONResponse($this->run($op, $uid, $args));
        } catch (\InvalidArgumentException $e) {
            return new JSONResponse(['message' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
        } catch (\RuntimeException $e) {
            // BoardService speaks in RuntimeExceptions with user-facing messages.
            $m = $e->getMessage();
            $status = match (true) {
                str_contains($m, 'not found'), str_contains($m, 'nothing to restore') => Http::STATUS_NOT_FOUND,
                str_contains($m, 'access denied') => Http::STATUS_FORBIDDEN,
                default => Http::STATUS_CONFLICT,
            };
            return new JSONResponse(['message' => $m], $status);
        } catch (\Throwable $e) {
            $this->logger->warning('Atrium agent todo call failed: ' . $e->getMessage(), ['app' => 'daily_todo', 'exception' => $e]);
            return new JSONResponse(['message' => $e->getMessage()], Http::STATUS_SERVICE_UNAVAILABLE);
        } finally {
            $this->events->actingAgent(null);
        }
    }

    /** @param array<string, mixed> $a */
    private function run(string $op, string $uid, array $a): array
    {
        return match ($op) {
            'today' => ['day' => $this->today($uid)],
            'day' => $this->service->getDay($uid, $this->date($uid, $a)),
            'overdue' => ['tasks' => $this->service->overdue($uid)],
            'trash' => ['items' => $this->service->trashList($uid)],
            'create' => ['id' => $this->service->createQuick($uid, $this->date($uid, $a), $this->str($a, 'title'), null, $this->int($a, 'parent_id'), $this->int($a, 'after_id'))],
            'complete' => $this->ok(fn() => $this->service->complete($uid, $this->id($a), (bool) ($a['done'] ?? true))),
            'rename' => $this->ok(fn() => $this->service->rename($uid, $this->id($a), $this->str($a, 'title'))),
            'reorder' => $this->ok(fn() => $this->service->reorder($uid, $this->date($uid, $a), $this->ids($a))),
            'postpone' => $this->service->postpone($uid, $this->id($a), $this->int($a, 'days') ?? 1),
            'delete' => ['trash_id' => $this->service->deleteQuick($uid, $this->id($a))],
            'restore' => $this->ok(fn() => $this->service->restore($uid, $this->int($a, 'trash_id') ?? throw new \InvalidArgumentException('trash_id is required'), (bool) ($a['today'] ?? false))),
            default => throw new \InvalidArgumentException("unknown operation \"$op\""),
        };
    }

    private function ok(callable $fn): array
    {
        $fn();
        return ['ok' => true];
    }

    private function today(string $uid): string
    {
        $b = $this->service->accessibleBoard($uid);
        return LogicalDate::forTimestamp(time(), (string) $b['timezone'], (int) $b['rollover_hour']);
    }

    /** `date` (YYYY-MM-DD) or the board's logical today. */
    private function date(string $uid, array $a): string
    {
        $d = $a['date'] ?? null;
        if ($d === null || $d === '' || $d === 'today') {
            return $this->today($uid);
        }
        if (!is_string($d) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $d)) {
            throw new \InvalidArgumentException('date must be YYYY-MM-DD or "today"');
        }
        return $d;
    }

    private function str(array $a, string $k): string
    {
        $v = $a[$k] ?? null;
        if (!is_string($v) || trim($v) === '') {
            throw new \InvalidArgumentException("$k is required");
        }
        return $v;
    }

    private function int(array $a, string $k): ?int
    {
        $v = $a[$k] ?? null;
        if ($v === null) {
            return null;
        }
        if (!is_int($v) && !(is_string($v) && ctype_digit($v))) {
            throw new \InvalidArgumentException("$k must be an integer");
        }
        return (int) $v;
    }

    private function id(array $a): int
    {
        return $this->int($a, 'item_id') ?? throw new \InvalidArgumentException('item_id is required');
    }

    /** @return list<int> */
    private function ids(array $a): array
    {
        $v = $a['item_ids'] ?? null;
        if (!is_array($v) || $v === []) {
            throw new \InvalidArgumentException('item_ids must be a non-empty list');
        }
        return array_map(fn($x) => is_int($x) ? $x : throw new \InvalidArgumentException('item_ids must be integers'), array_values($v));
    }
}
