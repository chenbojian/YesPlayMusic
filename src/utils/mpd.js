import * as _ from 'lodash';

const mympdUrl = process.env.VUE_APP_MYMPD_URL || 'http://localhost:8080';
const neteaseMusicDownloadUrl =
  process.env.VUE_APP_NETEASE_MUSIC_DOWNLOAD_URL || 'http://localhost:8000';
let socket;

const mpdState = {
  player: null,
  state: 'stop',
  pos: -1,
  data: null,
  onChange(prevState, prevPos) {
    console.log(`state changed from ${prevState} to ${this.state}`);
    console.log(`pos changed from ${prevPos} to ${this.pos}`);
    if (prevState === 'play' && this.state === 'stop') {
      console.log('calling onend...');
      this.onend();
      return;
    }
    if (
      prevState === 'play' &&
      this.state === 'play' &&
      prevPos !== this.pos &&
      prevPos !== -1
    ) {
      console.log('calling onend...');
      this.onend();
      return;
    }
  },
  onend: () => {},
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
window.callMpd = callMpd;

async function openWebSocket() {
  const playerState = await callMpd('MYMPD_API_PLAYER_STATE', {});
  mpdState.state = playerState.state;
  mpdState.pos = playerState.songPos;
  mpdState.data = playerState;

  socket = new WebSocket(`${mympdUrl.replace('http', 'ws')}/ws/default`);
  let intervalId;

  socket.addEventListener('open', () => {
    console.log(`websocket open ${new Date().toISOString()}`);
    intervalId = setInterval(() => {
      socket.send('ping');
    }, 5000);
  });

  socket.addEventListener('message', event => {
    if (!event.data) {
      return;
    }
    if (!event.data.startsWith('{')) {
      return;
    }
    const data = JSON.parse(event.data);
    if (data.method !== 'update_state') {
      return;
    }
    const prevState = mpdState.state;
    const prevPos = mpdState.pos;
    mpdState.state = data.params.state;
    mpdState.pos = data.params.songPos;
    mpdState.data = data.params;
    mpdState.onChange(prevState, prevPos);
  });

  socket.addEventListener('close', () => {
    console.log(`websocket close ${new Date().toISOString()}`);
    clearInterval(intervalId);
    setTimeout(openWebSocket);
  });
}

openWebSocket();

async function getListInMpd() {
  const queue = await callMpd('MYMPD_API_QUEUE_SEARCH', {
    offset: 0,
    limit: 100,
    sort: 'Priority',
    sortdesc: false,
    expression: '',
    fields: [
      'Pos',
      'Title',
      'Artist',
      'Album',
      'Duration',
      'AlbumArtist',
      'Genre',
      'Name',
    ],
  });
  function extractIdFromUrl(url) {
    const match = /neteasemusic\/(.+?)\//.exec(url);
    return match && +match[1];
  }
  const list = queue.data.map(s => extractIdFromUrl(s.uri));
  const mpdIds = queue.data.map(s => s.id);
  console.log('list in mpd: ', list);
  console.log('ids in mpd: ', mpdIds);

  return [list, mpdIds];
}

class MpdPlayer {
  static __nextId = 0;
  static __list = [];
  static __mpdIds = [];

  static async initList(list, getTrackDetail, getAudioSource) {
    let [mpdList, mpdIds] = await getListInMpd();
    if (_.isEqual(list, mpdList)) {
      MpdPlayer.__list = list;
      MpdPlayer.__mpdIds = mpdIds;
      return;
    }

    MpdPlayer.__list = [];
    await callMpd('MYMPD_API_QUEUE_CLEAR', {});
    for (let id of list) {
      const track = (await getTrackDetail(id)).songs[0]; // TODO: handle track.playable === false
      const source = await getAudioSource(track);
      const tags = {
        title: track.name,
        album: track.al.name,
        artist: track.ar.map(ar => ar.name).join('; '),
      };
      const response = await fetch(
        `${neteaseMusicDownloadUrl}/music/${track.id}`,
        {
          method: 'post',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            url: source,
            artist: track.ar.map(ar => ar.name).join('&'),
            name: track.name,
          }),
        }
      );
      const response_json = await response.json();
      await callMpd('MYMPD_API_QUEUE_APPEND_URI_TAGS', {
        uri: response_json.nfs,
        tags: tags,
        play: false,
      });
    }
    [mpdList, mpdIds] = await getListInMpd();
    MpdPlayer.__list = list;
    MpdPlayer.__mpdIds = mpdIds;
  }

  constructor({ src, html5, preload, format, onend, currentTrack, current }) {
    this.__id = MpdPlayer.__nextId++;
    console.log(`new MpdPlayer ${this.__id} to play ${currentTrack.name}`);

    this.src = src;
    this.html5 = html5;
    this.preload = preload;
    this.format = format;
    this.onend = onend;
    this.currentTrack = currentTrack;
    this.current = current;

    this.tags = {
      title: currentTrack.name,
      album: currentTrack.al.name,
      artist: currentTrack.ar.map(ar => ar.name).join('; '),
    };

    this._sounds = [];
    this.__playing = false;

    this.__onceCallbacks = {};
    this.__currentSongResult = null;
    this.__init_promise = new Promise(resolve => {
      const intervalId = setInterval(() => {
        if (MpdPlayer.__list.length > 0) {
          clearInterval(intervalId);
          resolve();
        }
      }, 500);
    });
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
      await this.__init_promise;
      const songId = MpdPlayer.__mpdIds[this.current];
      this.__currentSongResult = await callMpd(
        'MYMPD_API_PLAYER_CURRENT_SONG',
        {}
      );

      if (this.__currentSongResult.currentSongId == songId) {
        await callMpd('MYMPD_API_PLAYER_PLAY', {});
      } else {
        await callMpd('MYMPD_API_PLAYER_PLAY_SONG', { songId });
      }
      mpdState.onend = this.onend;
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
    console.log(`[${this.__id}] calling MpdPlayer.pause`);
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
