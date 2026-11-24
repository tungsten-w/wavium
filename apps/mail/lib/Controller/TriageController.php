<?php

declare(strict_types=1);

/*
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Mail\Controller;

use OCA\Mail\Db\MessageMapper;
use OCA\Mail\Exception\MailboxNotCachedException;
use OCA\Mail\Http\JsonResponse as MailJsonResponse;
use OCA\Mail\Service\Triage\TriageService;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Db\DoesNotExistException;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\OpenAPI;
use OCP\AppFramework\Http\JSONResponse;
use OCP\IGroupManager;
use OCP\IRequest;

#[OpenAPI(scope: OpenAPI::SCOPE_IGNORE)]
class TriageController extends Controller {
	public function __construct(
		IRequest $request,
		private TriageService $triage,
		private MessageMapper $messageMapper,
		private IGroupManager $groups,
		private ?string $userId,
	) {
		parent::__construct('mail', $request);
	}

	/** Pipeline status for the Status page. */
	#[NoAdminRequired]
	public function status(): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$status = $this->triage->status($this->userId);
		$status['canManage'] = $this->groups->isAdmin($this->userId);
		return new JSONResponse($status);
	}

	/** Classification of listed messages: ?ids=1,2,3 -> { id: summary }. */
	#[NoAdminRequired]
	public function messages(string $ids = ''): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$list = array_values(array_filter(array_map('intval', explode(',', $ids))));
		return new JSONResponse((object)$this->triage->forMessages($this->userId, $list));
	}

	/**
	 * Messages by label across folders: ?mailboxIds=1,2&category=ads,social&needsAction=1&flagged=1&cursor=..&limit=..
	 */
	#[NoAdminRequired]
	public function list(string $mailboxIds = '', string $category = '', string $exclude = '', bool $needsAction = false, ?int $cursor = null, int $limit = 20, bool $flagged = false): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		$boxes = array_values(array_filter(array_map('intval', explode(',', $mailboxIds))));
		$cats = array_values(array_filter(array_map('trim', explode(',', $category))));
		$skip = array_values(array_filter(array_map('trim', explode(',', $exclude))));
		// A folder with no local copy has no labelled mail to find, so this list
		// would answer 200 and an empty array -- and Curated would show "This
		// folder is empty" on an account that was just added, forever, because
		// nothing ever asked for the initial sync. Say "not cached" instead, the
		// same answer /messages gives, and name the folders: the client syncs
		// them and asks again.
		$uncached = $this->triage->uncachedMailboxIds($this->userId, $boxes);
		if ($uncached !== []) {
			return MailJsonResponse::fail([
				'message' => 'mailbox ' . implode(', ', $uncached) . ' is not cached',
				'type' => MailboxNotCachedException::class,
				'mailboxIds' => $uncached,
			]);
		}
		$ids = $this->triage->idsByLabel($this->userId, $boxes, $cats, $needsAction, $cursor, $limit, $skip, $flagged);
		return new JSONResponse($this->messageMapper->findByIds($this->userId, $ids, 'DESC'));
	}
	/** Queue one mail again (front of the queue) and classify it now when possible. */
	#[NoAdminRequired]
	public function reclassify(int $id): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			return new JSONResponse($this->triage->reclassify($this->userId, $id));
		} catch (DoesNotExistException) {
			return new JSONResponse(['message' => 'Message not found'], Http::STATUS_NOT_FOUND);
		}
	}

	/**
	 * The folders of one account to classify (V4-28): ?accountId=1&mailboxIds[]=2
	 * Not admin-only -- these are the person's own folders, and nothing is
	 * classified from an account that is not theirs.
	 */
	#[NoAdminRequired]
	public function setFolders(int $accountId, array $mailboxIds = []): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		try {
			$kept = $this->triage->setClassifiedFolders($this->userId, $accountId, array_values(array_map('intval', $mailboxIds)));
		} catch (DoesNotExistException) {
			return new JSONResponse(['message' => 'Account not found'], Http::STATUS_NOT_FOUND);
		}
		return new JSONResponse(['accountId' => $accountId, 'mailboxIds' => $kept]);
	}

	/**
	 * Catch up mail classified by an older question set (V4-28). Bounded and
	 * explicit: it queues at most `max` mails, as backlog, so the daily backlog
	 * cap decides how fast they are actually redone.
	 *
	 * The parameter is not called `limit`: the framework range-checks any
	 * controller parameter of that name against 1..500 and answers 500 when it
	 * is out of range (Dispatcher::ensureParameterValueSatisfiesRange), instead
	 * of letting the service clamp it.
	 */
	#[NoAdminRequired]
	public function backfill(int $max = 100): JSONResponse {
		if ($this->userId === null) {
			return new JSONResponse([], Http::STATUS_UNAUTHORIZED);
		}
		return new JSONResponse($this->triage->requeueOutdated($this->userId, $max));
	}

	/** Turn the pipeline on or off (admins: it spends the server's AI budget). */
	public function setEnabled(bool $enabled): JSONResponse {
		$this->triage->setEnabled($enabled);
		return new JSONResponse(['enabled' => $enabled]);
	}
}
