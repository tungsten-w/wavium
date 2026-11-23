<?php

/**
 * SPDX-FileCopyrightText: 2026 Atrium contributors
 * SPDX-License-Identifier: AGPL-3.0-or-later
 */

declare(strict_types=1);

namespace Test\Theming;

use OCA\Theming\Listener\BeforePreferenceListener;
use OCA\Theming\Listener\RandomAccentListener;
use OCP\App\IAppManager;
use OCP\Config\BeforePreferenceSetEvent;
use OCP\Config\IUserConfig;
use OCP\Config\ValueType;
use OCP\IConfig;
use OCP\IUser;
use OCP\User\Events\UserCreatedEvent;
use Test\TestCase;

/**
 * Changing the accent colour used to answer 500 on a brand-new account.
 *
 * Atrium gives every new account a random accent (RandomAccentListener). It
 * wrote that colour with a type ("string"), while the preferences API -- what
 * Settings > Appearance calls when the person picks a colour -- writes values
 * untyped ("mixed"). Nextcloud refuses to change the type of a stored value, so
 * the first colour change threw TypeConflictException.
 *
 * The accent is now written untyped, and an account that still carries a typed
 * one has it dropped just before the new colour is written.
 */
class AccentColourTypeTest extends TestCase {
	public function testANewAccountGetsAnUntypedAccent(): void {
		$userConfig = $this->createMock(IUserConfig::class);
		$userConfig->method('getValueString')->willReturn('');
		// The typed setter is what used to pin the type and break the next write.
		$userConfig->expects($this->never())->method('setValueString');
		$config = $this->createMock(IConfig::class);
		$config->expects($this->once())
			->method('setUserValue')
			->with('alice', 'theming', 'primary_color', $this->matchesRegularExpression('/^#[0-9a-f]{6}$/'));

		$user = $this->createMock(IUser::class);
		$user->method('getUID')->willReturn('alice');
		(new RandomAccentListener($userConfig, $config))->handle(new UserCreatedEvent($user, ''));
	}

	public function testAnAccountThatAlreadyHasATypedAccentIsRepairedOnTheNextChange(): void {
		$userConfig = $this->createMock(IUserConfig::class);
		$userConfig->method('hasKey')->willReturn(true);
		$userConfig->method('getValueType')->willReturn(ValueType::STRING);
		$userConfig->method('getValueString')->willReturn('2');
		$userConfig->expects($this->once())
			->method('deleteUserConfig')
			->with('alice', 'theming', 'primary_color');

		$this->listener($userConfig)->handle($this->setEvent('alice', 'primary_color', '#0b6aa8'));
	}

	public function testAnUntypedAccentIsLeftAlone(): void {
		$userConfig = $this->createMock(IUserConfig::class);
		$userConfig->method('hasKey')->willReturn(true);
		$userConfig->method('getValueType')->willReturn(ValueType::MIXED);
		$userConfig->method('getValueString')->willReturn('2');
		$userConfig->expects($this->never())->method('deleteUserConfig');
		// The cache buster still has to move, or classic pages keep the old colour.
		$userConfig->expects($this->once())
			->method('setValueString')
			->with('alice', 'theming', 'userCacheBuster', '3');

		$this->listener($userConfig)->handle($this->setEvent('alice', 'primary_color', '#0b6aa8'));
	}

	public function testAColourThatIsNotAColourChangesNothing(): void {
		$userConfig = $this->createMock(IUserConfig::class);
		$userConfig->expects($this->never())->method('deleteUserConfig');
		$userConfig->expects($this->never())->method('setValueString');

		$event = $this->setEvent('alice', 'primary_color', 'not-a-colour');
		$this->listener($userConfig)->handle($event);
		$this->assertFalse($event->isValid());
	}

	private function listener(IUserConfig $userConfig): BeforePreferenceListener {
		return new BeforePreferenceListener($this->createMock(IAppManager::class), $userConfig);
	}

	private function setEvent(string $uid, string $key, string $value): BeforePreferenceSetEvent {
		return new BeforePreferenceSetEvent($uid, 'theming', $key, $value);
	}
}
