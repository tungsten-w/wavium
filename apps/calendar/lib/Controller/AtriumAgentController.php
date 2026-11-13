<?php

declare(strict_types=1);

// SPDX-FileCopyrightText: 2026 Atrium contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

namespace OCA\Calendar\Controller;

use OC\Agent\InternalAuth;
use OCA\Calendar\Service\AtriumAgentCalendar;
use OCA\Calendar\Service\AtriumAgentError;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use OCP\IUserManager;
use OCP\IUserSession;
use Psr\Log\LoggerInterface;

/**
 * Calendar and Tasks for the Atrium agent layer (server/agent/calendar, P3-2).
 *
 * Internal only (X-Atrium-Internal, which only the Bun server can send). The
 * agent layer has already checked the agent's token and its calendar / tasks
 * grant for `uid` (the grantor); every call here acts as that user.
 */
final class AtriumAgentController extends Controller
{
    public function __construct(
        string $appName,
        IRequest $request,
        private AtriumAgentCalendar $calendar,
        private LoggerInterface $logger,
        private ?IUserManager $users = null,
        private ?IUserSession $session = null,
    ) {
        parent::__construct($appName, $request);
    }

    #[PublicPage]
    #[NoCSRFRequired]
    public function call(string $op, string $uid, array $args = []): JSONResponse
    {
        if (!\OCP\Server::get(InternalAuth::class)->isInternal($this->request)) {
            return new JSONResponse(['message' => 'internal only'], Http::STATUS_FORBIDDEN);
        }
        if ($uid === '') {
            return new JSONResponse(['message' => 'uid is required'], Http::STATUS_BAD_REQUEST);
        }
        // Internal calls have no session user. CalDAV listeners (Activity: "You created ...")
        // read it, so the grantor is the acting user for the duration of the call.
        $user = $this->users?->get($uid);
        if ($this->users !== null && $user === null) {
            return new JSONResponse(['message' => "No user $uid"], Http::STATUS_NOT_FOUND);
        }
        $this->session?->setVolatileActiveUser($user);
        try {
            return new JSONResponse($this->run($op, $uid, $args));
        } catch (AtriumAgentError $e) {
            return new JSONResponse(['message' => $e->getMessage()], $e->status);
        } catch (\InvalidArgumentException $e) {
            return new JSONResponse(['message' => $e->getMessage()], Http::STATUS_BAD_REQUEST);
        } catch (\Throwable $e) {
            $this->logger->warning('Atrium agent calendar call failed: ' . $e->getMessage(), ['app' => 'calendar', 'exception' => $e]);
            return new JSONResponse(['message' => $e->getMessage()], Http::STATUS_SERVICE_UNAVAILABLE);
        } finally {
            $this->session?->setVolatileActiveUser(null);
        }
    }

    /** @param array<string, mixed> $a */
    private function run(string $op, string $uid, array $a): array
    {
        $c = $this->calendar;
        return match ($op) {
            'calendars' => ['calendars' => $c->calendars($uid)],
            'events' => $c->events($uid, $this->when($a, 'from'), $this->when($a, 'to'), $this->opt($a, 'calendar_id'), $this->opt($a, 'query'), (int) ($a['limit'] ?? 100)),
            'event' => $c->event($uid, $this->req($a, 'event_id')),
            'event_create' => $c->createEvent($uid, $this->opt($a, 'calendar_id'), $this->fields($a)),
            'event_update' => $c->updateEvent($uid, $this->req($a, 'event_id'), $this->fields($a), $this->opt($a, 'etag')),
            'event_delete' => $c->delete($uid, $this->req($a, 'event_id'), 'VEVENT', $this->opt($a, 'etag')),
            'tasks' => $c->tasks($uid, $this->opt($a, 'calendar_id'), $this->status($a), isset($a['due_before']) ? $this->when($a, 'due_before') : null, $this->opt($a, 'query'), (int) ($a['limit'] ?? 100)),
            'task' => $c->task($uid, $this->req($a, 'task_id')),
            'task_create' => $c->createTask($uid, $this->opt($a, 'calendar_id'), $this->fields($a), $this->opt($a, 'parent_id')),
            'task_update' => $c->updateTask($uid, $this->req($a, 'task_id'), $this->fields($a), $this->opt($a, 'etag')),
            'task_delete' => $c->delete($uid, $this->req($a, 'task_id'), 'VTODO', $this->opt($a, 'etag')),
            'etag' => ['etag' => $c->etag($uid, $this->req($a, 'id'))],
            default => throw new \InvalidArgumentException("unknown operation \"$op\""),
        };
    }

    /** The editable fields present in the call (absent = unchanged, null = cleared). */
    private function fields(array $a): array
    {
        $f = $a['fields'] ?? [];
        if (!is_array($f)) {
            throw new \InvalidArgumentException('fields must be an object');
        }
        return $f;
    }

    private function req(array $a, string $k): string
    {
        $v = $a[$k] ?? null;
        if (!is_string($v) || $v === '') {
            throw new \InvalidArgumentException("$k is required");
        }
        return $v;
    }

    private function opt(array $a, string $k): ?string
    {
        $v = $a[$k] ?? null;
        return is_string($v) && $v !== '' ? $v : null;
    }

    private function status(array $a): string
    {
        $s = $a['status'] ?? 'open';
        if (!in_array($s, ['open', 'completed', 'all'], true)) {
            throw new \InvalidArgumentException('status is open, completed or all');
        }
        return $s;
    }

    private function when(array $a, string $k): \DateTimeImmutable
    {
        $v = $this->req($a, $k);
        try {
            return (new \DateTimeImmutable($v))->setTimezone(new \DateTimeZone('UTC'));
        } catch (\Throwable) {
            throw new \InvalidArgumentException("$k is not an ISO date");
        }
    }
}
