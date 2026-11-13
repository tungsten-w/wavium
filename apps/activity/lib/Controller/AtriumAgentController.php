<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Activity\Controller;

use OC\Agent\InternalAuth;
use OCA\Activity\Data;
use OCA\Activity\GroupHelper;
use OCA\Activity\UserSettings;
use OCP\Activity\IManager;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IRequest;
use OCP\IUserManager;
use Psr\Log\LoggerInterface;

/**
 * The activity stream for the agent layer (P3-5), read only. Called only by
 * the Bun server (server/agent/activity/) with X-Atrium-Internal, as `uid`.
 * Same data and rendering as the Activity app's OCS API v2.
 */
class AtriumAgentController extends Controller {
	public function __construct(
		string $appName,
		IRequest $request,
		private Data $data,
		private GroupHelper $helper,
		private UserSettings $settings,
		private IManager $activityManager,
		private IUserManager $users,
		private LoggerInterface $logger,
	) {
		parent::__construct($appName, $request);
	}

	private static function error(int $status, string $message): JSONResponse {
		return new JSONResponse(['message' => $message], $status);
	}

	/** Filter ids an agent may use: all, self, by, plus the apps' own filters (files, calendar, ...). */
	#[PublicPage]
	#[NoCSRFRequired]
	public function filters(string $uid = ''): JSONResponse {
		if (!\OCP\Server::get(InternalAuth::class)->isInternal($this->request)) {
			return self::error(Http::STATUS_FORBIDDEN, 'internal only');
		}
		$out = [];
		foreach ($this->activityManager->getFilters() as $f) {
			$out[] = ['id' => $f->getIdentifier(), 'name' => $f->getName()];
		}
		return new JSONResponse(['filters' => $out]);
	}

	/**
	 * Newest first. `since` = an activity_id from a previous page (older ones
	 * follow). `filter` = a filter id; `object_type` + `object_id` = one item.
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	public function list(string $uid = '', int $since = 0, int $limit = 30, string $filter = 'all', string $object_type = '', int $object_id = 0): JSONResponse {
		if (!\OCP\Server::get(InternalAuth::class)->isInternal($this->request)) {
			return self::error(Http::STATUS_FORBIDDEN, 'internal only');
		}
		if ($uid === '' || $this->users->get($uid) === null) {
			return self::error(Http::STATUS_NOT_FOUND, 'No such user');
		}
		if ($object_type !== '' && $object_id > 0) {
			$filter = 'filter';
		} elseif ($filter !== 'all' && $filter !== 'self' && $filter !== 'by') {
			try {
				$this->activityManager->getFilterById($filter);
			} catch (\Throwable) {
				return self::error(Http::STATUS_BAD_REQUEST, "Unknown filter $filter");
			}
		}
		$limit = max(1, min(100, $limit));
		$this->activityManager->setCurrentUserId($uid);
		$this->activityManager->setRequirePNG(false);
		try {
			$res = $this->data->get($this->helper, $this->settings, $uid, $since, $limit, 'desc', $filter, $object_type, $object_id);
		} catch (\OutOfBoundsException) {
			return self::error(Http::STATUS_BAD_REQUEST, 'Bad cursor');
		} catch (\BadMethodCallException) {
			return new JSONResponse(['activities' => [], 'has_more' => false]);
		} catch (\Throwable $e) {
			$this->logger->warning('Atrium agent activity call failed: ' . $e->getMessage(), ['exception' => $e]);
			return self::error(Http::STATUS_SERVICE_UNAVAILABLE, 'Activity is unavailable');
		} finally {
			$this->activityManager->setCurrentUserId(null);
		}
		$rows = [];
		foreach ($res['data'] as $a) {
			$rows[] = [
				'activity_id' => (int)$a['activity_id'],
				'time' => (int)$a['timestamp'],
				'app' => (string)$a['app'],
				'type' => (string)$a['type'],
				'by' => $a['user'] !== '' ? (string)$a['user'] : null,
				'subject' => (string)$a['subject'],
				'message' => $a['message'] !== '' ? (string)$a['message'] : null,
				'object_type' => $a['object_type'] !== '' ? (string)$a['object_type'] : null,
				'object_id' => (int)$a['object_id'] ?: null,
				'object_name' => $a['object_name'] !== '' ? (string)$a['object_name'] : null,
				'link' => $a['link'] !== '' ? (string)$a['link'] : null,
			];
		}
		return new JSONResponse(['activities' => $rows, 'has_more' => (bool)$res['has_more']]);
	}
}
