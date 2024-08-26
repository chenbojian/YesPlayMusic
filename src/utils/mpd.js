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

function openWebSocket() {
  const socket = new WebSocket('ws://localhost:8080/ws/default');

  socket.addEventListener('open', () => {});

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
    setTimeout(openWebSocket);
  });
}

openWebSocket();

const mympdUrl = process.env.VUE_APP_MYMPD_URL || 'http://localhost:8080';

class MpdPlayer {
  constructor({ src, html5, preload, format, onend, currentTrack }) {
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

    this.__onceCallbacks = {};
    this.__currentSongResult = null;

    mpdState.reset();

    if (currentTrack.playable) {
      this.__replace_uris = this.__callMpd('MYMPD_API_QUEUE_REPLACE_URI_TAGS', {
        uri: this.src[0],
        tags: this.tags,
        play: false,
      }).then(() => {
        mpdState.onend = onend;
      });
    } else {
      this.__callMpd('MYMPD_API_QUEUE_CLEAR', {}).then(() => {
        onend();
      });
    }
  }

  async __callMpd(method, params) {
    const res = await fetch(mympdUrl + '/api/default', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 850999009,
        method: method,
        params: params,
      }),
    });
    const resJson = await res.json();
    return resJson.result;
  }

  seek() {
    // TODO: support this._howler?.seek(time);
    if (mpdState.state === 'play' && this.__currentSongResult) {
      let process =
        Math.floor(Date.now() / 1000) - this.__currentSongResult.startTime;
      return process;
    }
    if (mpdState.state === 'pause') {
      return mpdState.data.elapsedTime;
    }
    return 0;
  }

  playing() {
    return this.__playing;
  }
  async play() {
    if (mpdState.state === 'pause') {
      await this.__callMpd('MYMPD_API_PLAYER_RESUME', {});
    } else {
      this.__currentSongResult = null;
      await this.__replace_uris;
      await this.__callMpd('MYMPD_API_PLAYER_PLAY', {});
    }

    this.__currentSongResult = await this.__callMpd(
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
    await this.__callMpd('MYMPD_API_PLAYER_PAUSE', {});
    this.__playing = false;
  }

  async stop() {
    await this.__callMpd('MYMPD_API_PLAYER_STOP', {});
  }

  on(event, callback) {
    console.log(event, callback);
  }
}

export default MpdPlayer;

// MYMPD_API_PLAYER_RESUME
// MYMPD_API_PLAYER_RESUME
// MYMPD_API_PLAYER_PAUSE
