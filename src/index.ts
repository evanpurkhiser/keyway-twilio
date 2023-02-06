import * as Sentry from '@sentry/node';
import {
  ServerlessEventObject,
  ServerlessFunctionSignature,
} from '@twilio-labs/serverless-runtime-types/types';
import fetch from 'node-fetch';
import Twilio from 'twilio';
import VoiceResponse from 'twilio/lib/twiml/VoiceResponse';

Sentry.init({dsn: process.env.SENTRY_DSN});

/**
 * Base URL used for communicating with the keyway authentication server
 */
const ENDPOINT_URL = process.env.KEYWAY_SERVICE_URL;

/**
 * This is the number that the callbox will forward to if there are ANY issues
 * communicating with the keyway service.
 */
const FALLBACK_NUMBER = process.env.KEYWAY_FALLBACK_NUMBER;

interface RequestParameters extends ServerlessEventObject {
  /**
   * Number called from
   */
  Caller: string;
  /**
   * Number called
   */
  Called: string;
  /**
   * When authorization has been gathered, this will be present
   */
  Digits?: string;
}

type Env = {
  /**
   * API key used to communicate with the keyway service
   */
  API_KEY: string;
};

/**
 * When the user does not enter an access code this configuration tells the
 * service who the call should be forwarded to.
 */
type ForwardingConfig = {
  /**
   * The name of the contact the callbox will forward to on failure
   */
  name: string;
  /**
   * The number of the contact to call
   */
  number: string;
};

/**
 * Maps the number called via the callbox to the ForwardingConfig for user who
 * owns the callbox number
 */
type ConfigMapping = Record<string, ForwardingConfig>;

type TriggerResponse = {
  /**
   * The entry code used to unlock the door
   */
  entryCode: string;
  /**
   * The configuration mapping
   */
  configMapping: ConfigMapping;
  /**
   * The expected number of digits needed for authentication
   */
  numDigits: number;
  /**
   * The total number of codes that are currently registered
   */
  numRegisteredCodes: number;
  /**
   * The total number of single use codes currently registered
   */
  numSingleUseCodes: number;
};

type AuthResponse =
  | {status: 'denied'}
  | {
      status: 'granted';
      name: string | null;
      visitNumber: number;
      isSingleUse: boolean;
      lastVisit: string | null;
    };

type Handler = ServerlessFunctionSignature<Env, RequestParameters>;

/**
 * Trigger the door to unlock via a DTMF code
 */
function unlock(twiml: VoiceResponse) {
  twiml.pause({length: 1});
  twiml.play({digits: '9'});
}

/**
 * Say some text
 */
function say(instance: {say: VoiceResponse['say']}, m: string) {
  const speech = instance.say('');
  speech.prosody({volume: 'x-loud'}, m);
}

/**
 * Handle when a call first comes in, and no authorization has been provded.
 */
const handleCall: Handler = async function (ctx, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  const resp = await fetch(`${ENDPOINT_URL}/callbox_trigger`, {
    method: 'POST',
    body: JSON.stringify(event),
    headers: {'x-ad-access': ctx.API_KEY},
  });

  // Something is broken on the appdaemon endpoint. Log and just directly call
  // the target.
  if (!resp.ok) {
    const err = new Error('Failed to trigger callbox API');
    Sentry.captureException(err, {
      level: 'fatal',
      extra: {error: resp.statusText, ...event},
    });

    await Sentry.close(2000);

    twiml.dial(FALLBACK_NUMBER);
    callback(null, twiml);
    return;
  }

  const data = (await resp.json()) as TriggerResponse;

  const target = data.configMapping[event.Called];

  // When we have single use codes available, give the user more time to enter.
  const gather = twiml.gather({
    numDigits: data.numDigits,
    timeout: data.numSingleUseCodes > 0 ? 20 : 10,
    input: ['dtmf'],
  });

  say(gather, 'Enter an access code, or wait to be connected.');

  // User did not dial the an access code, call the target person
  twiml.dial(target.number);

  callback(null, twiml);
};

/**
 * Handle when authorization has been provided
 */
const handleAuth: Handler = async function (ctx, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();

  const resp = await fetch(`${ENDPOINT_URL}/callbox_auth`, {
    method: 'POST',
    body: JSON.stringify({code: event.Digits}),
    headers: {'x-ad-access': ctx.API_KEY},
  });
  const data = (await resp.json()) as AuthResponse;

  if (data.status !== 'granted') {
    say(twiml, `Sorry, ${event.Digits.split('').join('-')} is invalid.`);
    twiml.redirect('/index');
    callback(null, twiml);
    return;
  }

  // If it's a single use code give them specific instructions to find the apartment.
  if (data.isSingleUse) {
    say(twiml, 'Valid access code. Apartment 5-0-7 is on floor 5.');
    unlock(twiml);
    callback(null, twiml);
    return;
  }

  // Welcome the user differently depending on if a name is configured for this
  // registered acess code.
  say(twiml, data.name !== null ? `Welcome ${data.name}` : 'Welcome in');

  // Tell them where the door is
  if (data.visitNumber === 1) {
    say(twiml, 'Find apartment 5-0-7 on floor 5.');
  }

  unlock(twiml);
  callback(null, twiml);
};

export const handler: Handler = (ctx, event, callback) =>
  event.Digits === undefined
    ? handleCall(ctx, event, callback)
    : handleAuth(ctx, event, callback);
