<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

namespace OCA\Files\Controller;

use OC\Agent\InternalAuth;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\JSONResponse;
use OCP\Constants;
use OCP\Files\File;
use OCP\Files\Folder;
use OCP\Files\IRootFolder;
use OCP\Files\Node;
use OCP\Files\NotFoundException;
use OCP\Files\NotPermittedException;
use OCP\IGroupManager;
use OCP\IRequest;
use OCP\IURLGenerator;
use OCP\IUserManager;
use OCP\IUserSession;
use OCP\Share\IManager as IShareManager;
use OCP\Share\IShare;
use Psr\Log\LoggerInterface;

/**
 * Files for the agent layer (P3-4). Called only by the Bun server
 * (server/agent/files/) with X-Atrium-Internal; each call acts as `uid` (a
 * volatile session user, so versions, trash bin, activity and sharing work as
 * for the user). Paths are relative to the user's home ("/Documents/a.txt").
 * Overwrites keep the old content as a version; deletes go to the trash bin.
 */
class AtriumAgentController extends Controller {
	public const MAX_READ = 2 * 1024 * 1024;
	public const MAX_BINARY = 1024 * 1024;
	public const MAX_WRITE = 5 * 1024 * 1024;
	private const TEXT_MIMES = ['application/json', 'application/xml', 'application/javascript', 'application/x-yaml', 'application/yaml',
		'application/x-sh', 'application/sql', 'application/x-php', 'application/toml', 'image/svg+xml'];

	private Folder $home;
	private string $uid;

	public function __construct(
		string $appName,
		IRequest $request,
		private IRootFolder $root,
		private IUserManager $users,
		private IUserSession $session,
		private IGroupManager $groups,
		private IURLGenerator $urls,
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
		$this->session->setVolatileActiveUser($user);
		try {
			$this->uid = $uid;
			$this->home = $this->root->getUserFolder($uid);
			return $fn();
		} catch (NotFoundException $e) {
			return self::error(Http::STATUS_NOT_FOUND, $e->getMessage() ?: 'Not found');
		} catch (NotPermittedException|\OCP\Files\ForbiddenException $e) {
			return self::error(Http::STATUS_FORBIDDEN, $e->getMessage() ?: 'Not permitted');
		} catch (\OCP\Lock\LockedException) {
			return self::error(Http::STATUS_CONFLICT, 'The file is locked (being written), try again');
		} catch (\InvalidArgumentException|\OCP\Files\InvalidPathException|\OCP\Share\Exceptions\GenericShareException $e) {
			return self::error(Http::STATUS_BAD_REQUEST, $e->getMessage() ?: 'Invalid input');
		} catch (\Throwable $e) {
			$this->logger->warning('Atrium agent files call failed: ' . $e->getMessage(), ['exception' => $e]);
			return self::error(Http::STATUS_SERVICE_UNAVAILABLE, 'Files are unavailable');
		} finally {
			$this->session->setVolatileActiveUser(null);
		}
	}

	/** "/a/./b/" -> "a/b"; refuses "..", control characters and empty names. */
	public static function cleanPath(string $path): string {
		if (preg_match('/[\x00-\x1f\x7f]/', $path)) {
			throw new \InvalidArgumentException('Invalid characters in path');
		}
		$parts = [];
		foreach (explode('/', str_replace('\\', '/', $path)) as $p) {
			if ($p === '' || $p === '.') {
				continue;
			}
			if ($p === '..') {
				throw new \InvalidArgumentException('".." is not allowed in paths');
			}
			$parts[] = $p;
		}
		return implode('/', $parts);
	}

	private function node(string $path, int $id = 0): Node {
		if ($id > 0) {
			$n = $this->home->getFirstNodeById($id);
			if ($n === null) {
				throw new NotFoundException("No file with id $id");
			}
			return $n;
		}
		$clean = self::cleanPath($path);
		return $clean === '' ? $this->home : $this->home->get($clean);
	}

	private function rel(Node $n): string {
		return '/' . ltrim((string)$this->home->getRelativePath($n->getPath()), '/');
	}

	private function view(Node $n): array {
		$p = $n->getPermissions();
		return [
			'file_id' => $n->getId(),
			'path' => $this->rel($n),
			'name' => $n->getName(),
			'type' => $n instanceof Folder ? 'folder' : 'file',
			'mime' => $n instanceof Folder ? null : $n->getMimetype(),
			'size' => (int)$n->getSize(),
			'modified' => (int)$n->getMTime(),
			'etag' => $n->getEtag(),
			'can' => [
				'write' => ($p & Constants::PERMISSION_UPDATE) !== 0,
				'delete' => ($p & Constants::PERMISSION_DELETE) !== 0,
				'share' => ($p & Constants::PERMISSION_SHARE) !== 0,
			],
			'shared_with_me' => $n->getOwner() !== null && $n->getOwner()->getUID() !== $this->uid,
		];
	}

	private static function isText(File $f): bool {
		$m = $f->getMimetype();
		return str_starts_with($m, 'text/') || in_array($m, self::TEXT_MIMES, true);
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function stat(string $uid = '', string $path = '', int $file_id = 0): JSONResponse {
		return $this->guard($uid, fn () => new JSONResponse($this->view($this->node($path, $file_id))));
	}

	/** Folder content, folders first then by name. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function list(string $uid = '', string $path = '', int $file_id = 0, int $limit = 100, int $offset = 0): JSONResponse {
		return $this->guard($uid, function () use ($path, $file_id, $limit, $offset) {
			$dir = $this->node($path, $file_id);
			if (!$dir instanceof Folder) {
				throw new \InvalidArgumentException('Not a folder');
			}
			$entries = $dir->getDirectoryListing();
			usort($entries, fn (Node $a, Node $b) => (($b instanceof Folder) <=> ($a instanceof Folder)) ?: strnatcasecmp($a->getName(), $b->getName()));
			$limit = max(1, min(500, $limit));
			$page = array_slice($entries, max(0, $offset), $limit);
			return new JSONResponse(['folder' => $this->view($dir), 'entries' => array_map(fn ($n) => $this->view($n), $page), 'total' => count($entries)]);
		});
	}

	/** Name search under `path` (default: everywhere), newest first. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function search(string $uid = '', string $query = '', string $path = '', int $limit = 50): JSONResponse {
		return $this->guard($uid, function () use ($query, $path, $limit) {
			$query = trim($query);
			if (mb_strlen($query) < 2) {
				throw new \InvalidArgumentException('query needs at least 2 characters');
			}
			$dir = $this->node($path);
			if (!$dir instanceof Folder) {
				throw new \InvalidArgumentException('Not a folder');
			}
			$found = $dir->search($query);
			usort($found, fn (Node $a, Node $b) => $b->getMTime() <=> $a->getMTime());
			$found = array_slice($found, 0, max(1, min(200, $limit)));
			return new JSONResponse(['results' => array_map(fn ($n) => $this->view($n), $found)]);
		});
	}

	/** Text content (UTF-8), or base64 for small binaries when asked. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function read(string $uid = '', string $path = '', int $file_id = 0, bool $binary = false): JSONResponse {
		return $this->guard($uid, function () use ($path, $file_id, $binary) {
			$f = $this->node($path, $file_id);
			if (!$f instanceof File) {
				throw new \InvalidArgumentException('Not a file');
			}
			$size = (int)$f->getSize();
			if (!$binary && self::isText($f)) {
				if ($size > self::MAX_READ) {
					return self::error(Http::STATUS_REQUEST_ENTITY_TOO_LARGE, 'Text file over 2 MB: read it over WebDAV');
				}
				$content = $f->getContent();
				if (!mb_check_encoding($content, 'UTF-8')) {
					$content = mb_convert_encoding($content, 'UTF-8', 'Windows-1252');
				}
				return new JSONResponse($this->view($f) + ['encoding' => 'text', 'content' => $content]);
			}
			if (!$binary) {
				return self::error(Http::STATUS_UNSUPPORTED_MEDIA_TYPE, 'Not a text file (' . $f->getMimetype() . '): ask for binary (base64, max 1 MB)');
			}
			if ($size > self::MAX_BINARY) {
				return self::error(Http::STATUS_REQUEST_ENTITY_TOO_LARGE, 'Over 1 MB: download it over WebDAV');
			}
			return new JSONResponse($this->view($f) + ['encoding' => 'base64', 'content' => base64_encode($f->getContent())]);
		});
	}

	/**
	 * Creates or overwrites a file. An overwrite keeps the old content as a
	 * version. `etag`: refuse if the file changed; `create_only`: refuse if it exists.
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	public function write(string $uid = '', string $path = '', string $content = '', string $encoding = 'text', ?string $etag = null, bool $create_only = false, bool $create_parents = false): JSONResponse {
		return $this->guard($uid, function () use ($path, $content, $encoding, $etag, $create_only, $create_parents) {
			$clean = self::cleanPath($path);
			if ($clean === '') {
				throw new \InvalidArgumentException('path is required');
			}
			$data = $encoding === 'base64' ? base64_decode($content, true) : $content;
			if ($data === false) {
				throw new \InvalidArgumentException('content is not valid base64');
			}
			if (strlen($data) > self::MAX_WRITE) {
				throw new \InvalidArgumentException('Over 5 MB: upload it over WebDAV');
			}
			if ($this->home->nodeExists($clean)) {
				$f = $this->home->get($clean);
				if (!$f instanceof File) {
					throw new \InvalidArgumentException('A folder has this name');
				}
				if ($create_only) {
					return self::error(Http::STATUS_CONFLICT, 'The file exists');
				}
				if ($etag !== null && $etag !== '' && $f->getEtag() !== $etag) {
					return self::error(Http::STATUS_CONFLICT, 'The file changed since it was read');
				}
				$f->putContent($data);
				return new JSONResponse($this->view($this->home->get($clean)) + ['created' => false]);
			}
			$parentPath = dirname('/' . $clean);
			$parent = $this->folder($parentPath, $create_parents);
			$f = $parent->newFile(basename($clean), $data);
			return new JSONResponse($this->view($f) + ['created' => true]);
		});
	}

	private function folder(string $path, bool $create): Folder {
		$clean = self::cleanPath($path);
		if ($clean === '') {
			return $this->home;
		}
		if (!$this->home->nodeExists($clean)) {
			if (!$create) {
				throw new NotFoundException("No folder /$clean (pass create_parents)");
			}
			return $this->home->newFolder($clean);
		}
		$n = $this->home->get($clean);
		if (!$n instanceof Folder) {
			throw new \InvalidArgumentException("/$clean is a file");
		}
		return $n;
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function mkdir(string $uid = '', string $path = ''): JSONResponse {
		return $this->guard($uid, function () use ($path) {
			$clean = self::cleanPath($path);
			if ($clean === '') {
				throw new \InvalidArgumentException('path is required');
			}
			if ($this->home->nodeExists($clean)) {
				$n = $this->home->get($clean);
				if (!$n instanceof Folder) {
					throw new \InvalidArgumentException('A file has this name');
				}
				return new JSONResponse($this->view($n) + ['created' => false]);
			}
			return new JSONResponse($this->view($this->home->newFolder($clean)) + ['created' => true]);
		});
	}

	/** Move or rename. Refuses to overwrite. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function move(string $uid = '', string $path = '', int $file_id = 0, string $to = ''): JSONResponse {
		return $this->guard($uid, function () use ($path, $file_id, $to) {
			$n = $this->node($path, $file_id);
			if ($n->getId() === $this->home->getId()) {
				throw new \InvalidArgumentException('Cannot move the home folder');
			}
			$dest = self::cleanPath($to);
			if ($dest === '') {
				throw new \InvalidArgumentException('to is required');
			}
			if ($this->home->nodeExists($dest)) {
				return self::error(Http::STATUS_CONFLICT, "/$dest exists");
			}
			$moved = $n->move($this->home->getFullPath($dest));
			return new JSONResponse($this->view($moved));
		});
	}

	/** To the trash bin (restorable by the user). Returns what was deleted. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function delete(string $uid = '', string $path = '', int $file_id = 0, ?string $etag = null): JSONResponse {
		return $this->guard($uid, function () use ($path, $file_id, $etag) {
			$n = $this->node($path, $file_id);
			if ($n->getId() === $this->home->getId()) {
				throw new \InvalidArgumentException('Cannot delete the home folder');
			}
			if ($etag !== null && $etag !== '' && $n->getEtag() !== $etag) {
				return self::error(Http::STATUS_CONFLICT, 'Changed since the request');
			}
			$view = $this->view($n);
			$n->delete();
			return new JSONResponse(['deleted' => true, 'in_trash_bin' => \OCP\Server::get(\OCP\App\IAppManager::class)->isEnabledForUser('files_trashbin'), 'item' => $view]);
		});
	}

	private function shareView(IShare $s): array {
		$type = match ($s->getShareType()) {
			IShare::TYPE_USER => 'user',
			IShare::TYPE_GROUP => 'group',
			IShare::TYPE_LINK => 'link',
			IShare::TYPE_EMAIL => 'email',
			default => 'other',
		};
		$perm = $s->getPermissions();
		$node = null;
		try {
			$node = $s->getNode();
		} catch (\Throwable) {
		}
		return [
			'share_id' => (string)$s->getFullId(),
			'type' => $type,
			'with' => $type === 'link' ? null : $s->getSharedWith(),
			'path' => $node ? $this->rel($node) : null,
			'file_id' => $s->getNodeId(),
			'permission' => ($perm & (Constants::PERMISSION_UPDATE | Constants::PERMISSION_CREATE)) ? 'edit' : 'read',
			'expires' => $s->getExpirationDate()?->format('Y-m-d'),
			'has_password' => $s->getPassword() !== null && $s->getPassword() !== '',
			'url' => $type === 'link' ? $this->urls->linkToRouteAbsolute('files_sharing.sharecontroller.showShare', ['token' => $s->getToken()]) : null,
			'note' => $s->getNote() ?: null,
		];
	}

	/** Shares the user made, on one item or all. */
	#[PublicPage]
	#[NoCSRFRequired]
	public function shares(string $uid = '', string $path = '', int $file_id = 0): JSONResponse {
		return $this->guard($uid, function () use ($uid, $path, $file_id) {
			$node = ($path !== '' || $file_id > 0) ? $this->node($path, $file_id) : null;
			$sm = \OCP\Server::get(IShareManager::class);
			$out = [];
			foreach ([IShare::TYPE_USER, IShare::TYPE_GROUP, IShare::TYPE_LINK, IShare::TYPE_EMAIL] as $type) {
				foreach ($sm->getSharesBy($uid, $type, $node, false, 200) as $s) {
					$out[] = $this->shareView($s);
				}
			}
			return new JSONResponse(['shares' => $out]);
		});
	}

	/**
	 * Share with a user, a group, or as a public link. permission read|edit.
	 * expire_date YYYY-MM-DD. Returns the share (with the link URL).
	 */
	#[PublicPage]
	#[NoCSRFRequired]
	public function share(string $uid = '', string $path = '', int $file_id = 0, string $type = 'user', string $with = '', string $permission = 'read', ?string $expire_date = null, ?string $password = null, string $note = ''): JSONResponse {
		return $this->guard($uid, function () use ($uid, $path, $file_id, $type, $with, $permission, $expire_date, $password, $note) {
			$node = $this->node($path, $file_id);
			if ($node->getId() === $this->home->getId()) {
				throw new \InvalidArgumentException('Cannot share the home folder');
			}
			$sm = \OCP\Server::get(IShareManager::class);
			$s = $sm->newShare();
			$s->setNode($node)->setSharedBy($uid)->setShareOwner($node->getOwner()?->getUID() ?? $uid);
			switch ($type) {
				case 'user':
					if ($with === $uid || $this->users->get($with) === null) {
						throw new \InvalidArgumentException("No user $with");
					}
					$s->setShareType(IShare::TYPE_USER)->setSharedWith($with);
					break;
				case 'group':
					if (!$this->groups->groupExists($with)) {
						throw new \InvalidArgumentException("No group $with");
					}
					$s->setShareType(IShare::TYPE_GROUP)->setSharedWith($with);
					break;
				case 'link':
					$s->setShareType(IShare::TYPE_LINK);
					if ($password !== null && $password !== '') {
						$s->setPassword($password);
					}
					break;
				default:
					throw new \InvalidArgumentException('type must be user, group or link');
			}
			$read = Constants::PERMISSION_READ | Constants::PERMISSION_SHARE;
			$edit = $node instanceof Folder
				? Constants::PERMISSION_ALL
				: Constants::PERMISSION_READ | Constants::PERMISSION_UPDATE | Constants::PERMISSION_SHARE;
			if ($type === 'link') {
				// Public links: no reshare bit; folder edit = upload/change/delete.
				$read = Constants::PERMISSION_READ;
				$edit = $node instanceof Folder ? Constants::PERMISSION_ALL & ~Constants::PERMISSION_SHARE : Constants::PERMISSION_READ | Constants::PERMISSION_UPDATE;
			}
			$s->setPermissions($permission === 'edit' ? $edit : $read);
			if ($expire_date !== null && $expire_date !== '') {
				$d = \DateTime::createFromFormat('!Y-m-d', $expire_date);
				if ($d === false) {
					throw new \InvalidArgumentException('expire_date must be YYYY-MM-DD');
				}
				$s->setExpirationDate($d);
			}
			if ($note !== '') {
				$s->setNote(mb_substr($note, 0, 2000));
			}
			return new JSONResponse($this->shareView($sm->createShare($s)));
		});
	}

	#[PublicPage]
	#[NoCSRFRequired]
	public function unshare(string $uid = '', string $share_id = ''): JSONResponse {
		return $this->guard($uid, function () use ($uid, $share_id) {
			$sm = \OCP\Server::get(IShareManager::class);
			try {
				$s = $sm->getShareById($share_id, $uid);
			} catch (\OCP\Share\Exceptions\ShareNotFound) {
				throw new NotFoundException("No share $share_id");
			}
			if ($s->getSharedBy() !== $uid && $s->getShareOwner() !== $uid) {
				throw new NotFoundException("No share $share_id");
			}
			$view = $this->shareView($s);
			$sm->deleteShare($s);
			return new JSONResponse(['unshared' => true, 'share' => $view]);
		});
	}
}
