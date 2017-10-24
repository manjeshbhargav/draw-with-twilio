'use strict';

const { LocalDataTrack, connect, createLocalTracks } = require('twilio-video');

const download = document.getElementById('download');
const file = document.getElementById('file');
const connectButton = document.getElementById('connect');
const disconnectButton = document.getElementById('disconnect');
const form = document.getElementById('form');
const identityInput = document.getElementById('identity');
const nameInput = document.getElementById('name');
const participants = document.getElementById('participants');
const video = document.querySelector('#local-participant > video');

/**
 * Send a file over the LocalDataTrack
 * @param {HTMLInputElement} fileInput
 * @param {LocalDataTrack} dataTrack
 */
function sendFile(fileInput, dataTrack) {
  const file = fileInput.files[0];
  const chunkSize = 16384;
  let nChunks = Math.ceil(file.size / chunkSize);
  const sliceFile = function(offset) {
    const reader = new window.FileReader();
    reader.onload = (function(file) {
      return function(e) {
        console.log(--nChunks + ' chunks left to be sent');
        dataTrack.send(e.target.result);
        if (file.size > offset + e.target.result.byteLength) {
          window.setTimeout(sliceFile, 100, offset + chunkSize);
        }
      };
    })(file);
    const slice = file.slice(offset, offset + chunkSize);
    reader.readAsArrayBuffer(slice);
  };
  dataTrack.send(JSON.stringify({ name: file.name, size: file.size }));
  sliceFile(0);
}

/**
 * Setup a LocalDataTrack to transmit mouse coordinates.
 * @returns {LocalDataTrack} dataTrack
 */
function setupLocalDataTrack() {
  const dataTrack = new LocalDataTrack();
  file.addEventListener('change', () => sendFile(file, dataTrack));
  return dataTrack;
}

/**
 * Setup a LocalAudioTrack and LocalVideoTrack to render to a <video> element.
 * @param {HTMLVideoElement} video
 * @returns {Promise<Array<LocalAudioTrack|LocalVideoTrack>>} audioAndVideoTrack
 */
async function setupLocalAudioAndVideoTracks(video) {
  const audioAndVideoTrack = await createLocalTracks();
  audioAndVideoTrack.forEach(track => track.attach(video));
  return audioAndVideoTrack;
}

/**
 * Get an Access Token for the specified identity.
 * @param {string} identity
 * @returns {Promise<string>} token
 */
async function getToken(identity) {
  const response = await fetch(`/token?identity=${encodeURIComponent(identity)}`);
  if (!response.ok) {
    throw new Error('Unable to fetch Access Token');
  }
  return response.text();
}

let connectAttempt;
let room;

/**
 * Update the UI in response to disconnecting.
 * @returns {void}
 */
function didDisconnect(error) {
  if (room) {
    if (error) {
      console.error(error);
    }
    room.participants.forEach(participantDisconnected);
  }
  identityInput.disabled = false;
  nameInput.disabled = false;
  connectButton.disabled = false;
  disconnectButton.disabled = true;
}

/**
 * Run the app.
 * @returns {Promise<void>}
 */
async function main() {
  const dataTrack = setupLocalDataTrack();
  const audioAndVideoTrack = await setupLocalAudioAndVideoTracks(video);

  const tracks = audioAndVideoTrack.concat(dataTrack);

  connectButton.addEventListener('click', async event => {
    event.preventDefault();

    identityInput.disabled = true;
    nameInput.disabled = true;
    connectButton.disabled = true;
    disconnectButton.disabled = false;

    try {
      const identity = identityInput.value;
      const name = nameInput.value;

      console.log('Getting Access Token...');
      const token = await getToken(identity);
      console.log(`Got Access Token "${token}"`);

      console.log('Attempting to connect...');
      connectAttempt = connect(token, {
        name,
        tracks
      });

      room = await connectAttempt;
      console.log(`Connected to Room "${room.name}"`);

      // NOTE(mroberts): Save a reference to `room` on `window` for debugging.
      window.room = room;

      room.once('disconnected', didDisconnect);

      room.participants.forEach(participantConnected);
      room.on('participantConnected', participantConnected);
    } catch (error) {
      didDisconnect(error);
    }
  });

  disconnectButton.addEventListener('click', event => {
    event.preventDefault();

    if (connectAttempt) {
      connectAttempt.cancel();
    }

    if (room) {
      room.disconnect();
    }

    didDisconnect();
  });
}

/**
 * Handle a connected Participant.
 * @param {Participant} participant
 * @retruns {void}
 */
function participantConnected(participant) {
  const participantDiv = document.createElement('div');
  participantDiv.className = 'participant';
  participantDiv.id = participant.sid;

  const videoElement = document.createElement('video');
  participantDiv.appendChild(videoElement);

  participants.appendChild(participantDiv);

  participant.tracks.forEach(track => trackAdded(participant, track));
  participant.on('trackAdded', track => trackAdded(participant, track));
  participant.on('trackRemoved', track => trackRemoved(participant, track));
  participant.once('disconnected', () => participantDisconnected(participant));
}

/**
 * Handle a disconnnected Participant.
 * @param {Participant} participant
 * @returns {void}
 */
function participantDisconnected(participant) {
  console.log(`Participant "${participant.identity}" disconnected`);
  const participantDiv = document.getElementById(participant.sid);
  if (participantDiv) {
    participantDiv.remove();
  }
}

/**
 * Handle an added Track.
 * @param {Participant} participant
 * @param {Track} track
 * @returns {void}
 */
function trackAdded(participant, track) {
  console.log(`Participant "${participant.identity}" added ${track.kind} Track ${track.sid}`);
  if (track.kind === 'audio' || track.kind === 'video') {
    track.attach(`#${participant.sid} > video`);
  } else if (track.kind === 'data') {
    let fileBuf = [];
    let fileInfo = null;
    let sizeSoFar = 0;
    track.on('message', data => {
      if (!fileInfo) {
        fileInfo = JSON.parse(data);
        return;
      }
      fileBuf.push(data);
      sizeSoFar += data.byteLength;
      console.log(`${sizeSoFar} out of ${fileInfo.size} bytes downloaded`);
      if (sizeSoFar >= fileInfo.size) {
        const blob = new window.Blob(fileBuf);
        download.href = window.URL.createObjectURL(blob);
        download.download = fileInfo.name;
        download.textContent = `Click to download ${fileInfo.name} (${sizeSoFar} bytes)`;
        fileBuf = [];
        fileInfo = null;
        sizeSoFar = 0;
      }
    });
  }
}

/**
 * Handle a removed Track.
 * @param {Participant} participant
 * @param {Track} track
 * @returns {void}
 */
function trackRemoved(participant, track) {
  console.log(`Participant "${participant.identity}" removed ${track.kind} Track ${track.sid}`);
  if (track.kind === 'audio' || track.kind === 'video') {
    track.detach();
  }
}

// Go!
main().catch(console.error);
