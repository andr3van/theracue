import streamDeck, { LogLevel } from "@elgato/streamdeck";

import { PlayAudioAction } from "./actions/play-audio";

// We can enable "trace" logging so that all messages between the Stream Deck, and the plugin are recorded. When storing sensitive information
streamDeck.logger.setLevel(LogLevel.TRACE);

// Register the play audio action.
streamDeck.actions.registerAction(new PlayAudioAction());

// Finally, connect to the Stream Deck.
streamDeck.connect();
