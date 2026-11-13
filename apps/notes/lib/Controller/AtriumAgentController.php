<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Notes\Controller;

use OC\Agent\InternalAuth;
use OCA\Notes\Service\Note;
use OCA\Notes\Service\NoteDoesNotExistException;
use OCA\Notes\Service\NoteNotWritableException;
use OCA\Notes\Service\NotesService;
use OCA\Notes\Service\Util;
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
 * Notes for the agent layer (P3-5). Called only by the Bun server
 * (server/agent/notes/) with X-Atrium-Internal; every call acts as `uid`.
 * Goes through NotesService, so notes stay plain files in the user's Notes
 * folder (desktop sync, Notes mobile apps) and a delete lands in the Files
 * trash bin.
 */
class AtriumAgentController extends Controller {
	private const MAX_CONTENT = 1048576;
	/** Resolved per call, once the user is set (its TagService loads the session user's tags). */
	private NotesService $notes;

	public function __construct(
		string $appName,
		IRequest $request,
		private IUserManager $users,
		private IUserSession $session,
		private LoggerInterface $logger,
	) {
		parent::__construct($appName, $request);
	}

	private static function error(int $status, string $message): JSONResponse {
		return new JSONResponse(['message' => $message], $status);
	}

	private function guard(string $uid, callable $fn): JSONResponse {
		if (!\OCP\Server::get(InternalAuth::class)->isInternal($this->request)) {
			return self::error(Http::STATUS_FORBIDDEN, 'internal only');
		}
		$user = $uid === '' ? null : $this->users->get($uid);
		if ($user === null) {
			return self::error(Http::STATUS_NOT_FOUND, 'No such user');
		}
		// Act as the user for this request only: the Notes services (favorites
		// = file tags, activity) read the session user.
		$this->session->setVolatileActiveUser($user);
		try {
			$this->notes = \OCP\Server::get(NotesService::class);
			return Util::retryIfLocked($fn);
		} catch (NoteDoesNotExistException) {
			return self::error(Http::STATUS_NOT_FOUND, 'No such note');
		} catch (NoteNotWritableException) {
			return self::error(Http::STATUS_FORBIDDEN, 'This note is read-only');
		} catch (\InvalidArgumentException|\OCP\Files\InvalidPathException $e) {
			return self::error(Http::STATUS_BAD_REQUEST, $e->getMessage() ?: 'Invalid title or category');
		} catch (\OCA\Notes\Service\InsufficientStorageException) {
			return self::error(Http::STATUS_INSUFFICIENT_STORAGE, 'Not enough storage');
		} catch (\Throwable $e) {
			$this->logger->warning('Atrium agent notes call failed: ' . $e->getMessage(), ['exception' => $e]);
			return self::error(Http::STATUS_SERVICE_UNAVAILABLE, 'Notes are unavailable');
		} finally {
			$this->session->setVolatileActiveUser(null);
		}
	}

	/** Changes when the content, title, category or favorite change. */
	private static function etag(Note $n): string {
		return md5($n->getFileEtag() . '|' . $n->getTitle() . '|' . $n->getCategory() . '|' . ($n->getFavorite() ? '1' : '0'));
	}

	private static function meta(Note $n): array {
		return [
			'id' => $n->getId(),
			'title' => $n->getTitle(),
			'category' => $n->getCategory(),
			'favorite' => $n->getFavorite(),
			'read_only' => $n->getReadOnly(),
			'modified' => $n->getModified(),
			'etag' => self::etag($n),
		];
	}

	private static function text(mixed $v, string $name, int $max): ?string {
		if ($v === null) {
			return null;
		}
		if (!is_string($v)) {
			throw new \InvalidArgumentException("$name must be a string");
		}
		if (strlen($v) > $max) {
			throw new \InvalidArgumentException("$name is too long");
		}
		return $v;
	}

	/** Metadata and a short excerpt of every note, newest first; `query` searches title and content. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function list(string $uid = '', string $query = '', ?string $category = null): JSONResponse {
		return $this->guard($uid, function () use ($uid, $query, $category) {
			$all = trim($query) !== '' ? $this->notes->search($uid, trim($query)) : $this->notes->getAll($uid)['notes'];
			$rows = [];
			foreach ($all as $n) {
				if ($category !== null && $n->getCategory() !== $category && !str_starts_with($n->getCategory(), $category . '/')) {
					continue;
				}
				$rows[] = self::meta($n) + ['excerpt' => $n->getExcerpt(200)];
			}
			usort($rows, fn ($a, $b) => $b['modified'] <=> $a['modified'] ?: $b['id'] <=> $a['id']);
			$cats = $this->notes->getAll($uid)['categories'] ?? [];
			return new JSONResponse(['notes' => $rows, 'categories' => array_values($cats)]);
		});
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function get(string $uid = '', int $id = 0): JSONResponse {
		return $this->guard($uid, function () use ($uid, $id) {
			$n = $this->notes->get($uid, $id);
			return new JSONResponse(self::meta($n) + ['content' => $n->getContent()]);
		});
	}

	/** New note. Without a title, the first line of the content is the title (like the Notes app). */
	#[PublicPage]
	#[NoCSRFRequired]
	public function create(string $uid = '', mixed $title = null, mixed $content = '', mixed $category = '', bool $favorite = false): JSONResponse {
		return $this->guard($uid, function () use ($uid, $title, $content, $category, $favorite) {
			$content = self::text($content, 'content', self::MAX_CONTENT) ?? '';
			$title = self::text($title, 'title', 200);
			$category = self::text($category, 'category', 500) ?? '';
			if ($title === null || trim($title) === '') {
				$title = $this->notes->getTitleFromContent($content);
			}
			$n = $this->notes->create($uid, $title, $category);
			if ($content !== '') {
				$n->setContent($content);
			}
			if ($favorite) {
				$n->setFavorite(true);
			}
			return new JSONResponse(self::meta($n) + ['content' => $n->getContent()]);
		});
	}

	/**
	 * Changes what is given. `append` adds text at the end (on a new line).
	 * `etag` (optional) refuses the change if the note changed meanwhile.
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	public function update(string $uid = '', int $id = 0, mixed $content = null, mixed $append = null, mixed $title = null, mixed $category = null, ?bool $favorite = null, ?string $etag = null): JSONResponse {
		return $this->guard($uid, function () use ($uid, $id, $content, $append, $title, $category, $favorite, $etag) {
			$n = $this->notes->get($uid, $id);
			if ($etag !== null && $etag !== '' && self::etag($n) !== $etag) {
				return self::error(Http::STATUS_CONFLICT, 'The note changed since it was read');
			}
			if ($n->getReadOnly()) {
				throw new NoteNotWritableException();
			}
			$content = self::text($content, 'content', self::MAX_CONTENT);
			$append = self::text($append, 'append', self::MAX_CONTENT);
			$title = self::text($title, 'title', 200);
			$category = self::text($category, 'category', 500);
			if ($append !== null) {
				$base = $content ?? $n->getContent();
				$content = $base === '' ? $append : rtrim($base, "\n") . "\n" . $append;
			}
			if ($content !== null && strlen($content) > self::MAX_CONTENT) {
				throw new \InvalidArgumentException('content is too long');
			}
			if ($content !== null && $content !== $n->getContent()) {
				$n->setContent($content);
				$this->notes->contentEdited($uid, $n);
			}
			if ($title !== null && trim($title) !== '' && $title !== $n->getTitle()) {
				$n->setTitleCategory($title, $category);
			} elseif ($category !== null && $category !== $n->getCategory()) {
				$n->setCategory($category);
			}
			if ($favorite !== null && $favorite !== $n->getFavorite()) {
				$n->setFavorite($favorite);
			}
			$n = $this->notes->get($uid, $n->getId());
			return new JSONResponse(self::meta($n) + ['content' => $n->getContent()]);
		});
	}

	/** Moves the note file to the Files trash bin (restorable there). */
	#[PublicPage]
	#[NoCSRFRequired]
	public function delete(string $uid = '', int $id = 0): JSONResponse {
		return $this->guard($uid, function () use ($uid, $id) {
			$n = $this->notes->get($uid, $id);
			$title = $n->getTitle();
			$this->notes->delete($uid, $id);
			return new JSONResponse(['deleted' => true, 'title' => $title]);
		});
	}
}
