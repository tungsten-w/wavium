<?php

declare(strict_types=1);

namespace OCA\DailyTodo\Service;

/** Nothing is public for this owner (unknown user, or no public items). Maps to a 404. */
final class PublicStatusNotFound extends \RuntimeException {}
