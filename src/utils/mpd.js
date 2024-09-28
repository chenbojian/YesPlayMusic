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

export class Mpd {
  async getNfsUrl(track) {
    const source = await store.state.player._getAudioSource(track);
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
      if (!track.playable) {
        console.log(`${track.name} 无法播放，忽略.`);
        continue;
      }
      const nfsUrl = await this.getNfsUrl(track);
      await this.append(nfsUrl, track);
      store.dispatch('showToast', `完成添加 ${track.name} 到 MPD Playlist`);
    }
  }

  async append(uri, track) {
    const tags = {
      title: track.name,
      album: track.al.name,
      artist: track.ar.map(ar => ar.name).join('; '),
    };
    await callMpd('MYMPD_API_QUEUE_APPEND_URI_TAGS', {
      uri: uri,
      tags: tags,
      play: false,
    });
  }
}
