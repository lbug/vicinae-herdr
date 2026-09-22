/// <reference types="@vicinae/api">

/*
 * This file is auto-generated from the extension's manifest.
 * Do not modify manually. Instead, update the `package.json` file.
 */

type ExtensionPreferences = {
  /** Herdr binary - Path to the herdr binary. With the default 'herdr', ~/.local/bin/herdr is tried first, then PATH. */
	"herdrPath": string;

	/** Refresh interval (seconds) - How often the status view re-queries herdr. */
	"refreshInterval": "2" | "5" | "10" | "30";
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