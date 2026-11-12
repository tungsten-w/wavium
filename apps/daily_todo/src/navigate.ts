/** Go to another page of Nextcloud. Kept in one place so tests can replace it. */
export const goTo = (url: string): void => {
	window.location.href = url
}
