const mpdState = {
  _state: 'stop',
  get state() {
    return this._state;
  },
  set state(value) {
    const prevState = this._state;
    this._state = value;
    this.onStateChange(prevState, this._state);
  },
  data: null,
  onStateChange(prevState, curState) {
    if (prevState === curState) {
      return;
    }
    console.log(`state changed from ${prevState} to ${curState}`);
    if (prevState === 'play' && curState === 'stop') {
      console.log('calling onend...');
      this.onend();
    }
  },
  onend: () => {},
  reset() {
    this.state = 'stop';
    this.data = null;
    this.onend = () => {};
  },
};

async function callMpd(method, params) {
  console.log(`calling mpd with ${method}, ${JSON.stringify(params)}`);
  const res = await fetch(mympdUrl + '/api/default', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 950999009,
      method: method,
      params: params,
    }),
  });
  const resJson = await res.json();
  return resJson.result;
}

let socket;

function openWebSocket() {
  socket = new WebSocket('ws://localhost:8080/ws/default');

  socket.addEventListener('open', () => {
    console.log(`websocket open ${new Date().toISOString()}`);
    socket.send('ping');
  });

  socket.addEventListener('message', event => {
    if (!event.data) {
      return;
    }
    const data = JSON.parse(event.data);
    if (data.method !== 'update_state') {
      return;
    }
    mpdState.state = data.params.state;
    mpdState.data = data.params;
  });

  socket.addEventListener('close', () => {
    console.log(`websocket close ${new Date().toISOString()}`);
    setTimeout(openWebSocket);
  });
}

openWebSocket();

const mympdUrl = process.env.VUE_APP_MYMPD_URL || 'http://localhost:8080';

class MpdPlayer {
  static __nextId = 0;
  constructor({ src, html5, preload, format, onend, currentTrack }) {
    this.__id = MpdPlayer.__nextId++;
    console.log(`new MpdPlayer ${this.__id} to play ${currentTrack.name}`);
    this.src = src;
    this.html5 = html5;
    this.preload = preload;
    this.format = format;
    this.currentTrack = currentTrack;
    this.tags = {
      title: currentTrack.name,
      album: currentTrack.al.name,
      artist: currentTrack.ar.map(ar => ar.name).join('; '),
    };

    this._sounds = [];
    this.__playing = false;

    this.__onceCallbacks = {};
    this.__currentSongResult = null;

    mpdState.reset();
    mpdState.onend = () => {
      console.log(`[${this.__id}] calling MpdPlyaer.onend`);
      onend();
    };
    if (currentTrack.playable) {
      this.__replace_uris = callMpd('MYMPD_API_QUEUE_REPLACE_URI_TAGS', {
        uri: this.src[0],
        tags: this.tags,
        play: false,
      });
    } else {
      callMpd('MYMPD_API_QUEUE_CLEAR', {}).then(() => {
        mpdState.onend();
      });
    }
  }

  seek() {
    // TODO: support this._howler?.seek(time);
    if (mpdState.state === 'play' && this.__currentSongResult) {
      let process =
        Math.floor(Date.now() / 1000) - this.__currentSongResult.startTime;
      console.log(
        `[${this.__id}] checking MpdPlayer.seek ${process} / ${~~(
          this.currentTrack.dt / 1000
        )}`
      );
      return process;
    }
    if (mpdState.state === 'pause') {
      return mpdState.data.elapsedTime;
    }
    return 0;
  }

  playing() {
    console.log(`[${this.__id}] checking MpdPlayer.playing ${this.__playing}`);
    return this.__playing;
  }
  async play() {
    console.log(`[${this.__id}] calling MpdPlayer.play`);
    if (mpdState.state === 'pause') {
      await callMpd('MYMPD_API_PLAYER_RESUME', {});
    } else {
      this.__currentSongResult = null;
      await this.__replace_uris;
      await callMpd('MYMPD_API_PLAYER_PLAY', {});
    }

    this.__currentSongResult = await callMpd(
      'MYMPD_API_PLAYER_CURRENT_SONG',
      {}
    );
    this.__playing = true;
    this.__onceCallbacks['play'] && this.__onceCallbacks['play']();
    this.__onceCallbacks['play'] = null;
  }

  once(event, callback) {
    this.__onceCallbacks[event] = callback;
  }

  fade() {
    setTimeout(() => {
      this.__onceCallbacks['fade'] && this.__onceCallbacks['fade']();
      this.__onceCallbacks['fade'] = null;
    }, 100);
  }
  async pause() {
    await callMpd('MYMPD_API_PLAYER_PAUSE', {});
    this.__playing = false;
  }

  async stop() {
    console.log(`[${this.__id}] calling MpdPlayer.stop`);
    await callMpd('MYMPD_API_PLAYER_STOP', {});
    this.__playing = false;
  }

  on(event, callback) {
    console.log(event, callback);
  }
}

export default MpdPlayer;

// MYMPD_API_PLAYER_RESUME
// MYMPD_API_PLAYER_RESUME
// MYMPD_API_PLAYER_PAUSE
