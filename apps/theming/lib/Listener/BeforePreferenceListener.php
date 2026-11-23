<?php

declare(strict_types=1);

/**
 * SPDX-FileCopyrightText: 2022 Nextcloud GmbH and Nextcloud contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */
namespace OCA\Theming\Listener;

use OCA\Theming\AppInfo\Application;
use OCP\App\IAppManager;
use OCP\Config\BeforePreferenceDeletedEvent;
use OCP\Config\BeforePreferenceSetEvent;
use OCP\Config\IUserConfig;
use OCP\Config\ValueType;
use OCP\EventDispatcher\Event;
use OCP\EventDispatcher\IEventListener;

/** @template-implements IEventListener<BeforePreferenceDeletedEvent|BeforePreferenceSetEvent> */
class BeforePreferenceListener implements IEventListener {

	/**
	 * @var string[]
	 */
	private const ALLOWED_KEYS = ['force_enable_blur_filter', 'shortcuts_disabled', 'primary_color'];

	public function __construct(
		private IAppManager $appManager,
		private IUserConfig $userConfig,
	) {
	}

	#[\Override]
	public function handle(Event $event): void {
		if (!$event instanceof BeforePreferenceSetEvent
			&& !$event instanceof BeforePreferenceDeletedEvent) {
			// Invalid event type
			return;
		}

		switch ($event->getAppId()) {
			case Application::APP_ID: $this->handleThemingValues($event);
				break;
			case 'core': $this->handleCoreValues($event);
				break;
		}
	}

	private function handleThemingValues(BeforePreferenceSetEvent|BeforePreferenceDeletedEvent $event): void {
		if (!in_array($event->getConfigKey(), self::ALLOWED_KEYS)) {
			// Not allowed config key
			return;
		}

		if ($event instanceof BeforePreferenceSetEvent) {
			switch ($event->getConfigKey()) {
				case 'force_enable_blur_filter':
					$event->setValid($event->getConfigValue() === 'yes' || $event->getConfigValue() === 'no');
					break;
				case 'shortcuts_disabled':
					$event->setValid($event->getConfigValue() === 'yes');
					break;
				case 'primary_color':
					$event->setValid(preg_match('/^\#([0-9a-f]{3}|[0-9a-f]{6})$/i', $event->getConfigValue()) === 1);
					break;
				default:
					$event->setValid(false);
			}
			if ($event->getConfigKey() === 'primary_color' && $event->isValid()) {
				$this->dropTypedAccent($event->getUserId());
				$this->bumpCacheBuster($event->getUserId());
			}
			return;
		}

		$event->setValid(true);
		if ($event->getConfigKey() === 'primary_color') {
			$this->bumpCacheBuster($event->getUserId());
		}
	}

	/**
	 * Atrium: accounts created before this was fixed have their accent stored as
	 * a string (RandomAccentListener wrote it that way), while the preferences
	 * API, which is about to write the new colour, writes it untyped. Nextcloud
	 * refuses to change the type of a stored value, so that write threw and the
	 * person's first colour change answered 500. Drop the stored value here; the
	 * controller writes it again immediately after.
	 */
	private function dropTypedAccent(string $userId): void {
		if ($this->userConfig->hasKey($userId, Application::APP_ID, 'primary_color')
			&& $this->userConfig->getValueType($userId, Application::APP_ID, 'primary_color') !== ValueType::MIXED) {
			$this->userConfig->deleteUserConfig($userId, Application::APP_ID, 'primary_color');
		}
	}

	/** Atrium: a new accent must reach classic pages at once, so change the theme CSS URL. */
	private function bumpCacheBuster(string $userId): void {
		$version = (int)$this->userConfig->getValueString($userId, Application::APP_ID, 'userCacheBuster', '0');
		$this->userConfig->setValueString($userId, Application::APP_ID, 'userCacheBuster', (string)($version + 1));
	}

	private function handleCoreValues(BeforePreferenceSetEvent|BeforePreferenceDeletedEvent $event): void {
		if ($event->getConfigKey() !== 'apporder') {
			// Not allowed config key
			return;
		}

		if ($event instanceof BeforePreferenceDeletedEvent) {
			$event->setValid(true);
			return;
		}

		$value = json_decode($event->getConfigValue(), true, flags:JSON_THROW_ON_ERROR);
		if (!is_array(($value))) {
			// Must be an array
			return;
		}

		foreach ($value as $id => $info) {
			// required format: [ navigation_id: string => [ order: int, app?: string ] ]
			if (!is_string($id) || !is_array($info) || empty($info) || !isset($info['order']) || !is_numeric($info['order']) || (isset($info['app']) && !$this->appManager->isEnabledForUser($info['app']))) {
				// Invalid config value, refuse the change
				return;
			}
		}
		$event->setValid(true);
	}
}
