<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\DAV\Connector\Sabre;

use OC\Authentication\Scope\ScopeContext;
use OC\Authentication\Scope\ScopeSet;
use OCA\DAV\CalDAV\Calendar;
use OCA\DAV\CalDAV\CalendarObject;
use OCP\Authentication\Scope\IScopeRegistry;
use Sabre\DAV\Exception\Forbidden;
use Sabre\DAV\Exception\NotFound;
use Sabre\DAV\Server;
use Sabre\DAV\ServerPlugin;
use Sabre\HTTP\RequestInterface;

/**
 * Enforces token scopes on WebDAV/CalDAV/CardDAV (remote.php/dav and the
 * legacy remote.php/webdav, caldav, carddav endpoints).
 *
 * Area from the path: files/uploads/trashbin/versions/comments/systemtags
 * -> files, addressbooks -> contacts, calendars -> calendar and/or tasks
 * from the iCalendar components (VEVENT -> calendar, VTODO -> tasks, both ->
 * both, anything else -> denied). Action from the method: reads, DELETE ->
 * delete, sharing POSTs -> share, everything else -> write.
 */
class ScopePlugin extends ServerPlugin {
	private const READ_METHODS = ['GET', 'HEAD', 'OPTIONS', 'PROPFIND', 'REPORT'];

	private const PATH_AREA = [
		'files' => 'files',
		'uploads' => 'files',
		'trashbin' => 'files',
		'versions' => 'files',
		'comments' => 'files',
		'systemtags' => 'files',
		'systemtags-relations' => 'files',
		'systemtags-current' => 'files',
		'addressbooks' => 'contacts',
		'calendars' => 'calendar',
		'public-calendars' => 'calendar',
		'system-calendars' => 'calendar',
		'calendar-subscriptions' => 'calendar',
	];

	private ?Server $server = null;

	public function __construct(
		private ScopeContext $scopeContext,
		private bool $legacyFilesRoot = false,
		private ?string $legacyArea = null,
	) {
	}

	#[\Override]
	public function initialize(Server $server): void {
		$this->server = $server;
		// After authentication (10) and the tree setup (100).
		$server->on('beforeMethod:*', [$this, 'checkScope'], 120);
	}

	public function checkScope(RequestInterface $request): void {
		$scopes = $this->scopeContext->getScopeSet();
		if ($scopes === null) {
			return;
		}
		foreach ($this->requiredScopes($request) as [$area, $action]) {
			if (!$scopes->allows($area, $action)) {
				throw new Forbidden('This app password does not grant "' . $area . ':' . $action . '"');
			}
		}
	}

	/**
	 * @return list<array{0: string, 1: string}>
	 */
	public function requiredScopes(RequestInterface $request): array {
		$method = strtoupper($request->getMethod());
		$path = trim($request->getPath(), '/');
		$segments = $path === '' ? [] : explode('/', $path);

		if ($this->legacyFilesRoot) {
			return [['files', $this->action($method, $request, false)]];
		}
		if ($this->legacyArea !== null) {
			array_unshift($segments, $this->legacyArea);
		}
		if ($segments === []) {
			// Root: discovery only.
			return in_array($method, self::READ_METHODS, true) ? [] : [['*', '*']];
		}
		if ($segments[0] === 'principals') {
			// Principals are needed for discovery; changing them is calendar config.
			return in_array($method, self::READ_METHODS, true) ? [] : [['calendar', IScopeRegistry::ACTION_WRITE]];
		}
		$area = self::PATH_AREA[$segments[0]] ?? null;
		if ($area === null) {
			// Unknown collection: only a full scope reaches it.
			return [['*', '*']];
		}
		$action = $this->action($method, $request, in_array($area, ['calendar', 'contacts'], true));
		if ($area === 'calendar' && $segments[0] === 'calendars') {
			return array_map(fn (string $a) => [$a, $action], $this->calendarAreas($request, $path, $method));
		}
		return [[$area, $action]];
	}

	private function action(string $method, RequestInterface $request, bool $sharable): string {
		if (in_array($method, self::READ_METHODS, true)) {
			return IScopeRegistry::ACTION_READ;
		}
		if ($method === 'DELETE') {
			return IScopeRegistry::ACTION_DELETE;
		}
		if ($sharable && $method === 'POST' && $this->isShareRequest($request)) {
			return IScopeRegistry::ACTION_SHARE;
		}
		return IScopeRegistry::ACTION_WRITE;
	}

	/** CalDAV/CardDAV sharing: POST with an oc:share / cs:share-resource body. */
	private function isShareRequest(RequestInterface $request): bool {
		$body = $request->getBodyAsString();
		$request->setBody($body);
		return preg_match('/<([a-z0-9-]+:)?(share|share-resource|publish-calendar|unpublish-calendar)[\s>\/]/i', $body) === 1;
	}

	/**
	 * Areas for a path under calendars/: from the components of the object
	 * (body for PUT, stored data otherwise) or of the calendar collection.
	 *
	 * @return list<string>
	 */
	private function calendarAreas(RequestInterface $request, string $path, string $method): array {
		$segments = explode('/', $path);
		if (count($segments) >= 4) {
			// calendars/<user>/<calendar>/<object>
			$data = null;
			if ($method === 'PUT') {
				$data = $request->getBodyAsString();
				$request->setBody($data);
			} else {
				$node = $this->node($path);
				if ($node instanceof CalendarObject) {
					$data = $node->get();
				}
			}
			if ($data !== null) {
				return self::areasForIcs((string)$data);
			}
		}
		if (count($segments) >= 3) {
			$node = $this->node(implode('/', array_slice($segments, 0, 3)));
			if ($node instanceof Calendar) {
				$set = $node->getProperties(['{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set']);
				$components = $set['{urn:ietf:params:xml:ns:caldav}supported-calendar-component-set'] ?? null;
				$components = $components === null ? ['VEVENT', 'VTODO'] : $components->getValue();
				// A collection belongs to "calendar" if it can hold events,
				// otherwise (task lists) to "tasks".
				return in_array('VEVENT', $components, true) ? ['calendar'] : ['tasks'];
			}
		}
		return ['calendar'];
	}

	/**
	 * VEVENT -> calendar, VTODO -> tasks; both -> both. Anything else
	 * (VJOURNAL, no component) -> unknown area "calendar_other", which only
	 * a full "*" scope grants.
	 *
	 * @return list<string>
	 */
	public static function areasForIcs(string $ics): array {
		preg_match_all('/^BEGIN:(VEVENT|VTODO|VJOURNAL|VFREEBUSY|VAVAILABILITY)\r?$/mi', $ics, $m);
		$components = array_unique(array_map('strtoupper', $m[1]));
		$areas = [];
		foreach ($components as $component) {
			$areas[] = match ($component) {
				'VEVENT' => 'calendar',
				'VTODO' => 'tasks',
				default => 'calendar_other',
			};
		}
		$areas = array_values(array_unique($areas));
		return $areas === [] ? ['calendar_other'] : $areas;
	}

	private function node(string $path): mixed {
		try {
			return $this->server?->tree->getNodeForPath($path);
		} catch (NotFound) {
			return null;
		}
	}
}
