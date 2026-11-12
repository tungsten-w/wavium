<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Theming\Listener;

use OCA\Theming\AppInfo\Application;
use OCP\Config\IUserConfig;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;
use OCP\User\Events\UserCreatedEvent;

/**
 * Atrium: every new account starts with its own accent colour (a random hue at a
 * lightness that keeps white text readable). The user can change it in Appearance.
 *
 * @template-implements IEventListener<UserCreatedEvent>
 */
class RandomAccentListener implements IEventListener {
	public function __construct(
		private IUserConfig $userConfig,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!$event instanceof UserCreatedEvent) {
			return;
		}
		$uid = $event->getUser()->getUID();
		if ($this->userConfig->getValueString($uid, Application::APP_ID, 'primary_color') !== '') {
			return;
		}
		$this->userConfig->setValueString($uid, Application::APP_ID, 'primary_color', self::randomAccent());
	}

	/** A random hue with fixed saturation/lightness, as #rrggbb. */
	public static function randomAccent(): string {
		return self::hslToHex(random_int(0, 359), 0.55, 0.40);
	}

	public static function hslToHex(int $h, float $s, float $l): string {
		$c = (1 - abs(2 * $l - 1)) * $s;
		$x = $c * (1 - abs(fmod($h / 60, 2) - 1));
		$m = $l - $c / 2;
		[$r, $g, $b] = match (intdiv($h % 360, 60)) {
			0 => [$c, $x, 0], 1 => [$x, $c, 0], 2 => [0, $c, $x],
			3 => [0, $x, $c], 4 => [$x, 0, $c], default => [$c, 0, $x],
		};
		return sprintf('#%02x%02x%02x', (int)round(($r + $m) * 255), (int)round(($g + $m) * 255), (int)round(($b + $m) * 255));
	}
}
