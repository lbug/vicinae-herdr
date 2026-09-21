/// <reference types="@vicinae/api">

/*
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 */

type ExtensionPreferences = {
  /** Herdr binary - Path to the herdr binary, or 'herdr' to resolve from PATH. Falls back to ~/.local/bin/herdr. */
	"herdrPath": string;

	/** Refresh interval (seconds) - How often the status view re-queries herdr. */
	"refreshInterval": string;
}

declare type Preferences = ExtensionPreferences

declare namespace Preferences {
  /** Command: Herdr Agent Status */
	export type Status = ExtensionPreferences & {
		
	}

	/** Command: Herdr Attention */
	export type Attention = ExtensionPreferences & {
		
	}
}

declare namespace Arguments {
  /** Command: Herdr Agent Status */
	export type Status = {
		
	}

	/** Command: Herdr Attention */
	export type Attention = {
		
	}
}