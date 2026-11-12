<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Controller;

use OCA\DailyTodo\Service\BoardService;
use OCA\DailyTodo\Service\PublicStatusNotFound;
use OCP\AppFramework\Controller;
use OCP\AppFramework\Http\Attribute\AnonRateLimit;
use OCP\AppFramework\Http\Attribute\NoAdminRequired;
use OCP\AppFramework\Http\Attribute\NoCSRFRequired;
use OCP\AppFramework\Http\Attribute\PublicPage;
use OCP\AppFramework\Http\DataResponse;
use OCP\IRequest;
use OCP\IUserSession;
use Psr\Log\LoggerInterface;

final class ApiController extends Controller
{
    public function __construct(
        IRequest $request,
        private IUserSession $session,
        private BoardService $service,
        private LoggerInterface $logger,
    ) {
        parent::__construct('daily_todo', $request);
    }

    #[NoAdminRequired]
    public function day(string $date, ?string $owner = null): DataResponse
    {
        return $this->respond(
            fn() => $this->service->getDay($this->userId(), $date, $owner),
        );
    }

    #[NoAdminRequired]
    public function complete(int $id, bool $completed): DataResponse
    {
        return $this->respond(function () use ($id, $completed): array {
            $this->service->complete($this->userId(), $id, $completed);
            return ['ok' => true];
        });
    }

    #[NoAdminRequired]
    public function order(string $date, array $ids, ?string $owner = null): DataResponse
    {
        return $this->respond(function () use ($date, $ids, $owner): array {
            $this->service->reorder($this->userId(), $date, $ids, $owner);
            return ['ok' => true];
        });
    }

    #[NoAdminRequired]
    public function createQuick(string $date, string $title, ?string $owner = null, ?int $parentId = null, ?int $afterId = null): DataResponse
    {
        return $this->respond(fn() => [
            'id' => $this->service->createQuick($this->userId(), $date, $title, $owner, $parentId, $afterId),
        ]);
    }

    #[NoAdminRequired]
    public function resetDay(string $date): DataResponse
    {
        return $this->respond(function () use ($date): array {
            $this->service->resetDay($this->userId(), $date);
            return ['ok' => true];
        });
    }

    #[NoAdminRequired]
    public function updateQuick(int $id, string $title): DataResponse
    {
        return $this->respond(function () use ($id, $title): array {
            $this->service->rename($this->userId(), $id, $title);
            return ['ok' => true];
        });
    }

    #[NoAdminRequired]
    public function deleteQuick(int $id): DataResponse
    {
        return $this->respond(function () use ($id): array {
            return ['trash' => $this->service->deleteQuick($this->userId(), $id)];
        });
    }

    #[NoAdminRequired]
    public function postpone(int $id, int $days = 1): DataResponse
    {
        return $this->respond(fn() => $this->service->postpone($this->userId(), $id, $days));
    }

    #[NoAdminRequired]
    public function restore(int $id, bool $today = false): DataResponse
    {
        return $this->respond(function () use ($id, $today): array {
            $this->service->restore($this->userId(), $id, $today);
            return ['ok' => true];
        });
    }

    #[NoAdminRequired]
    public function taskDetails(int $id): DataResponse
    {
        return $this->respond(fn() => $this->service->taskDetails($this->userId(), $id));
    }

    #[NoAdminRequired]
    public function editTask(int $id, string $title = '', string $description = '', int $priority = 0, ?string $start = null, ?string $due = null): DataResponse
    {
        return $this->respond(fn() => $this->service->editTask($this->userId(), $id, [
            'title' => $title,
            'description' => $description,
            'priority' => $priority,
            'start' => $start === '' ? null : $start,
            'due' => $due === '' ? null : $due,
        ]));
    }

    #[NoAdminRequired]
    public function overdue(): DataResponse
    {
        return $this->respond(fn() => $this->service->overdue($this->userId()));
    }

    #[NoAdminRequired]
    public function moveOverdue(string $sourceId): DataResponse
    {
        return $this->respond(function () use ($sourceId): array {
            $this->service->moveOverdueToToday($this->userId(), $sourceId);
            return ['ok' => true];
        });
    }

    #[NoAdminRequired]
    public function trash(): DataResponse
    {
        return $this->respond(fn() => $this->service->trashList($this->userId()));
    }

    /**
     * Public, read-only: are the owner's public items (Settings → Public status) ticked today.
     * No login, so a desktop can poll it: `GET /public/{owner}/status`.
     */
    #[PublicPage]
    #[NoCSRFRequired]
    #[AnonRateLimit(limit: 120, period: 60)]
    public function publicStatus(string $owner): DataResponse
    {
        try {
            return new DataResponse($this->service->publicStatus($owner));
        } catch (PublicStatusNotFound) {
            return new DataResponse(['error' => 'Not found'], 404);
        } catch (\Throwable $e) {
            $this->logger->error('Public status failed', ['app' => 'daily_todo', 'exception' => $e]);
            return new DataResponse(['error' => 'Server error'], 500);
        }
    }

    #[NoAdminRequired]
    public function stats(string $from, string $to): DataResponse
    {
        return $this->respond(fn() => $this->service->stats($this->userId(), $from, $to));
    }

    #[NoAdminRequired]
    public function settings(): DataResponse
    {
        return $this->respond(fn() => $this->service->settings($this->userId()));
    }

    #[NoAdminRequired]
    public function saveSettings(array $settings): DataResponse
    {
        return $this->respond(
            fn() => $this->service->saveSettings($this->userId(), $settings),
        );
    }

    #[NoAdminRequired]
    public function sources(): DataResponse
    {
        return $this->respond(fn() => $this->service->sources($this->userId()));
    }

    #[NoAdminRequired]
    public function template(): DataResponse
    {
        return $this->respond(fn() => $this->service->template($this->userId()));
    }

    #[NoAdminRequired]
    public function saveTemplate(array $rows): DataResponse
    {
        return $this->respond(
            fn() => $this->service->saveTemplate($this->userId(), $rows),
        );
    }

    #[NoAdminRequired]
    public function dayVersion(string $date, ?string $owner = null): DataResponse
    {
        return $this->respond(
            fn() => $this->service->dayVersion($this->userId(), $date, $owner),
        );
    }

    #[NoAdminRequired]
    public function summary(string $month, ?string $owner = null): DataResponse
    {
        return $this->respond(
            fn() => $this->service->summary($this->userId(), $month, $owner),
        );
    }

    #[NoAdminRequired]
    public function shared(): DataResponse
    {
        return $this->respond(fn() => $this->service->sharedWithMe($this->userId()));
    }

    #[NoAdminRequired]
    public function shares(): DataResponse
    {
        return $this->respond(fn() => $this->service->shares($this->userId()));
    }

    #[NoAdminRequired]
    public function addShare(string $type, string $with): DataResponse
    {
        return $this->respond(function () use ($type, $with): array {
            $this->service->addShare($this->userId(), $type, $with);
            return ['ok' => true];
        });
    }

    #[NoAdminRequired]
    public function deleteShare(int $id): DataResponse
    {
        return $this->respond(function () use ($id): array {
            $this->service->deleteShare($this->userId(), $id);
            return ['ok' => true];
        });
    }

    private function userId(): string
    {
        return $this->session->getUser()?->getUID()
            ?? throw new \RuntimeException('Authentication required');
    }

    private function respond(callable $callback): DataResponse
    {
        try {
            return new DataResponse($callback());
        } catch (\Throwable $error) {
            return new DataResponse(['error' => $error->getMessage()], 400);
        }
    }
}
