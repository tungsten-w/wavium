<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Calendar\Controller;

use OCA\DAV\CalDAV\CalDavBackend;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\FrontpageRoute;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use Sabre\VObject\Reader;

/**
 * Subscribed (iCal URL) calendars expose no objects over CalDAV, so the Calendar
 * UI reads their cached events here: the events in a range, recurrence expanded.
 */
class SubscriptionController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private CalDavBackend $backend,
		private ?string $userId,
	) {
		parent::__construct($appName, $request);
	}

	#[NoAdminRequired]
	#[FrontpageRoute(verb: 'GET', url: '/subscription/{uri}/events')]
	public function events(string $uri, int $from, int $to): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$id = null;
		foreach ($this->backend->getSubscriptionsForUser('principals/users/' . $this->userId) as $s) {
			if ($s['uri'] === $uri) {
				$id = (int)$s['id'];
			}
		}
		if ($id === null) {
			return new JSONResponse([], Http::STATUS_NOT_FOUND);
		}
		$start = (new \DateTimeImmutable('@' . $from));
		$end = (new \DateTimeImmutable('@' . $to));
		$uris = array_map(fn (array $o) => $o['uri'], $this->backend->getCalendarObjects($id, CalDavBackend::CALENDAR_TYPE_SUBSCRIPTION));
		$out = [];
		foreach (array_chunk($uris, 200) as $chunk) {
			foreach ($this->backend->getMultipleCalendarObjects($id, $chunk, CalDavBackend::CALENDAR_TYPE_SUBSCRIPTION) as $o) {
				try {
					$cal = Reader::read($o['calendardata']);
					$cal = $cal->expand($start, $end);
				} catch (\Throwable $e) {
					continue;
				}
				if (count($cal->select('VEVENT')) === 0) {
					continue;
				}
				$out[] = ['href' => $o['uri'], 'etag' => trim((string)($o['etag'] ?? ''), '"'), 'data' => $cal->serialize()];
			}
		}
		return new JSONResponse($out);
	}
}
