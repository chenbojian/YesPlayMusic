import { getTrackDetail } from '@/api/track';
import * as _ from 'lodash';
import store from '@/store';

const mympdUrl = process.env.VUE_APP_MYMPD_URL || 'http://localhost:8080';
const neteaseMusicDownloadUrl =
  process.env.VUE_APP_NETEASE_MUSIC_DOWNLOAD_URL || 'http://localhost:8000';

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

class StatusTracker {
  constructor() {
    this.done = false;

    this.deferred = {};
    this.promise = new Promise((resolve, reject) => {
      this.deferred.resolve = resolve;
      this.deferred.reject = reject;
    });
  }

  markAsDone() {
    if (!this.done) {
      this.done = true;
      this.deferred.resolve();
    }
  }
}

class MpdPlayer {
  constructor() {
    const state = {};
    state.currentSongId = 0;
    state.elapsedTime = 0;
    state.lastSongId = 0;
    state.nextSongId = 0;
    state.nextSongPos = -1;
    state.queueLength = 0;
    state.songPos = -1;
    state.state = 'stop';
    state.totalTime = 0;
    state.volume = 0;
    this.currentSong = {};
    this.listeners = {};
    this.updateState(state);
    this.initialSync = new StatusTracker();
    this.openWebSocket();
  }

  updateState(state) {
    const playAnother =
      this.state === 'play' &&
      state.state === 'play' &&
      this.currentSongId !== state.currentSongId;
    const stopped = this.state !== 'stop' && state.state === 'stop';

    this.currentSongId = state.currentSongId;
    this.elapsedTime = state.elapsedTime;
    this.lastSongId = state.lastSongId;
    this.nextSongId = state.nextSongId;
    this.nextSongPos = state.nextSongPos;
    this.queueLength = state.queueLength;
    this.songPos = state.songPos;
    this.state = state.state;
    this.totalTime = state.totalTime;
    this.volume = state.volume;

    if (playAnother) {
      this.listeners['playAnother'] && this.listeners['playAnother']();
    }
    if (stopped) {
      this.listeners['stopped'] && this.listeners['stopped']();
    }
  }

  on(event, callback) {
    this.listeners[event] = callback;
  }

  async sync() {
    const playerState = await callMpd('MYMPD_API_PLAYER_STATE', {});
    this.currentSong = await callMpd('MYMPD_API_PLAYER_CURRENT_SONG', {});
    this.updateState(playerState);
  }

  async openWebSocket() {
    await this.sync();
    this.initialSync.markAsDone();
    const socket = new WebSocket(
      `${mympdUrl.replace('http', 'ws')}/ws/default`
    );
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

      this.updateState(data.params);
    });

    socket.addEventListener('close', () => {
      console.log(`websocket close ${new Date().toISOString()}`);
      clearInterval(intervalId);
      setTimeout(() => this.openWebSocket());
    });
  }

  get playing() {
    return this.state === 'play';
  }

  async play(songId) {
    await this.sync();
    if (songId && songId !== this.currentSongId) {
      await callMpd('MYMPD_API_PLAYER_PLAY_SONG', { songId });
    } else {
      await callMpd('MYMPD_API_PLAYER_PLAY', {});
    }
    await this.sync();
  }

  async resume() {
    await callMpd('MYMPD_API_PLAYER_RESUME', {});
  }

  async pause() {
    await callMpd('MYMPD_API_PLAYER_PAUSE', {});
  }

  async stop() {
    await callMpd('MYMPD_API_PLAYER_STOP', {});
  }
}

export class Mpd {
  constructor(yesMusicPlayer) {
    this.yesMusicPlayer = yesMusicPlayer;
    this.queue = [];
    this.player = new MpdPlayer();
    this._isSyncListFromPlayerDone = true;

    this.player.on('playAnother', async () => {
      await this.syncListFromPlayer();
      const trackId = this.queue[this.player.songPos].trackId;
      await this.yesMusicPlayer._replaceCurrentTrack(trackId); // will trigger play again, but will not break anything. also have some delay.
    });
    this.player.on('stopped', () => {
      this.yesMusicPlayer.pause();
    });

    // sync yesMusicPlayer with mpd's playing status when first time load page;
    this.player.initialSync.promise.then(() => {
      if (this.player.playing) {
        if (this.player.songPos !== this.yesMusicPlayer.current) {
          return this.player.listeners['playAnother']();
        } else {
          this.yesMusicPlayer._setPlaying(true);
        }
      }
      return Promise.resolve();
    });

    window.mpd = this;
  }

  async getSongId(trackId) {
    await this.syncListFromPlayer();

    return this.queue.filter(i => i.trackId === trackId)[0].id;
  }

  async syncListFromPlayer() {
    if (!this._isSyncListFromPlayerDone) {
      await new Promise(resolve => {
        const intervalId = setInterval(() => {
          if (this._isSyncListFromPlayerDone) {
            clearInterval(intervalId);
            resolve();
          }
        }, 500);
      });
    }
    this._isSyncListFromPlayerDone = false;
    await this.sync();
    const mpdList = this.queue.map(i => i.trackId);
    if (!_.isEqual(this.yesMusicPlayer.list, mpdList)) {
      await this.clear();
      await this.appendByTrackIds(this.yesMusicPlayer.list);
    }

    this._isSyncListFromPlayerDone = true;
  }

  async sync() {
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
    this.queue = queue.data.map(i => ({
      ...i,
      trackId: extractIdFromUrl(i.uri),
    }));
  }

  async getNfsUrl(track) {
    const source = await this.yesMusicPlayer._getAudioSource(track);
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
    return response_json.nfs;
  }

  async appendByTrackIds(trackIds) {
    const tracks = (await getTrackDetail(trackIds.join(','))).songs;
    for (let track of tracks) {
      const nfsUrl = await this.getNfsUrl(track);
      await this.append(nfsUrl, track);
    }
    await this.sync();
  }

  async append(uri, track) {
    const tags = {
      title: track.name,
      album: track.al.name,
      artist: track.ar.map(ar => ar.name).join('; '),
    };
    store.dispatch('showToast', `正在添加 ${tags.title} 到 MPD Playlist`);
    await callMpd('MYMPD_API_QUEUE_APPEND_URI_TAGS', {
      uri: uri,
      tags: tags,
      play: false,
    });
  }

  async clear() {
    await callMpd('MYMPD_API_QUEUE_CLEAR', {});
  }
}

export class FakeHowler {
  constructor({ current, currentTrack, mpd }) {
    this.current = current;
    this.currentTrack = currentTrack;
    this.mpd = mpd;
    this._playing = false;
    this._sounds = [];

    this.__onceCallbacks = {};
  }

  seek() {
    // TODO: support this._howler?.seek(time);
    if (this.mpd.player.state === 'play') {
      let process =
        Math.floor(Date.now() / 1000) - this.mpd.player.currentSong.startTime;
      return process;
    }
    if (this.mpd.player.state === 'pause') {
      return this.mpd.player.elapsedTime;
    }
    return 0;
  }

  playing() {
    return this._playing;
  }
  async play() {
    if (
      this.mpd.player.state === 'pause' &&
      this.mpd.player.songPos === this.current
    ) {
      await this.mpd.player.resume();
      this._playing = true;
    } else {
      const songId = await this.mpd.getSongId(this.currentTrack.id);
      await this.mpd.player.play(songId);
      this._playing = true;
    }

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
    await this.mpd.player.pause();
    this._playing = false;
  }

  async stop() {
    await this.mpd.player.stop();
    this._playing = false;
  }

  on(event, callback) {
    console.log(event, callback);
  }
}
