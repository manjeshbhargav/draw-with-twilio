'use strict';

const { LocalDataTrack, connect, createLocalTracks } = require('twilio-video');

const download = document.getElementById('download');
const connectButton = document.getElementById('connect');
const disconnectButton = document.getElementById('disconnect');
const fileInput = document.getElementById('file');
const identityInput = document.getElementById('identity');
const nameInput = document.getElementById('name');
const participants = document.getElementById('participants');
const video = document.querySelector('#local-participant > video');

const DEFAULT_CHUNK_INTERVAL_MS = 0;
const DEFAULT_CHUNK_SIZE_BYTES = 16384;

/**
 * Get a chunk of the give file.
 * @param {*} file
 * @param {number} offset
 * @param {number} chunkSize
 * @returns {Promise<*>}
 */
function getFileChunk(file, offset, chunkSize) {
  return new Promise(resolve => {
    const reader = new window.FileReader();
    reader.addEventListener('load', event => {
      resolve(event.target.result);
    });
    const fileChunk = file.slice(offset, offset + chunkSize);
    reader.readAsArrayBuffer(fileChunk);
  });
}

/**
 * Wait for the given amount of time.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Send a file over the LocalDataTrack
 * @param {*} file
 * @param {LocalDataTrack} dataTrack
 */
async function sendFile(file, dataTrack) {
  const { name, size } = file;
  const params = getURLParameters();

  const chunkInterval = params.has('chunkInterval')
    ? Number(params.get('chunkInterval'))
    : DEFAULT_CHUNK_INTERVAL_MS;

  const chunkSize = params.has('chunkSize')
    ? Number(params.get('chunkSize'))
    : DEFAULT_CHUNK_SIZE_BYTES;

  const nChunks = Math.ceil(size / chunkSize);

  dataTrack.send(JSON.stringify({
    chunkSize,
    name,
    size
  }));

  for (let offset = 0, chunksSoFar = 0; offset < size; offset += chunkSize) {
    const chunk = await getFileChunk(file, offset, chunkSize);
    dataTrack.send(chunk);
    download.textContent = `${++chunksSoFar} out of ${nChunks} chunks sent`;
    await new wait(chunkInterval);
  }
}

/**
 * Setup a LocalDataTrack to transmit mouse coordinates.
 * @returns {LocalDataTrack} dataTrack
 */
function setupLocalDataTrack() {
  const dataTrack = new LocalDataTrack();
  fileInput.addEventListener('change', () => {
    sendFile(fileInput.files[0], dataTrack);
  });
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
    let chunksSoFar = 0;
    let fileBuf = [];
    let fileInfo = null;
    let nChunks = 0;

    track.on('message', data => {
      if (!fileInfo) {
        fileInfo = JSON.parse(data);
        nChunks = Math.ceil(fileInfo.size / fileInfo.chunkSize);
        return;
      }
      fileBuf.push(data);
      download.textContent = `${++chunksSoFar} out of ${nChunks} chunks received`;

      if (chunksSoFar < nChunks) {
        return;
      }
      const blob = new window.Blob(fileBuf);
      download.href = window.URL.createObjectURL(blob);
      download.download = fileInfo.name;
      download.textContent = fileInfo.name;

      chunksSoFar = 0;
      fileBuf = [];
      fileInfo = null;
      nChunks = 0;
    });
  }
}

/**
 * Get URL parameters in a Map.
 * @param {string} [url=window.location.href]
 * @returns {Map<string, string>}
 */
function getURLParameters(url) {
  url = url || window.location.href;
  const search = url.split('?')[1] || '';
  const nvPairs = search.match(/([^?&=]+)=([^?&=]+)/g) || [];
  return new Map(nvPairs.map(nvPair => nvPair.split('=')));
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
