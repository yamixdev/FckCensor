import { net } from '@pulsesync/addon-sdk'
import type { Album, Artist, RemoteList, SpoofableType, Track } from '@/types'
import { error, log, warn } from '@/utils/logger'
import { versionsSatisfies } from '@/utils/version-utils'
import addonConfig from '../../addon.config.mjs'
import type { ArtistInsertions } from './dto/artist-insertion'
import { Source } from './dto/sources/source'
import TrackReplacement from './dto/track-replacement'
import { postProcess, sources } from './main-api'
import { DATA_LIST_API_URI, DATA_LIST_URI } from '@/hooks/ui/constants'
import { showNotificationSafe } from '@/utils/ui-utils'
import { handleNotifications } from '@/ui/notifications'

let list: RemoteSource | null = null

const endpoints = [
    { url: DATA_LIST_URI, accept: 'application/json' },
    { url: DATA_LIST_API_URI, accept: 'application/vnd.github.raw+json' },
]

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function fetchRemoteList(url: string, accept: string, signal: AbortSignal): Promise<RemoteList> {
    const payload = await net.json<unknown>(url, { headers: { Accept: accept }, signal, timeoutMs: 8_000 })
    if (!isRecord(payload) || !Array.isArray(payload.sources) || !payload.sources.every(isRecord)) {
        throw new TypeError('Invalid replacement catalog: expected a sources array')
    }
    return payload as unknown as RemoteList
}

export async function loadRemoteList(signal: AbortSignal) {
    if (list || signal.aborted) return

    for (const { url, accept } of endpoints) {
        if (signal.aborted) return
        let data: RemoteList
        let source: RemoteSource
        try {
            data = await fetchRemoteList(url, accept, signal)
            source = new RemoteSource(new MinifiedRemoteSource(data))
        } catch (cause) {
            if (signal.aborted) return
            warn('Could not load replacement catalog from', new URL(url).hostname, cause)
            continue
        }

        if (signal.aborted || list) return
        list = source
        sources.pushSource(source)
        log('Loaded remote list from', new URL(url).hostname)
        if (Array.isArray(data.notifications)) {
            void handleNotifications(data.notifications).catch(cause => warn('Could not process catalog notifications', cause))
        }
        return
    }

    if (list || signal.aborted) return
    error('Automatic replacement catalog is unavailable')
    void showNotificationSafe('Не удалось загрузить список автоматических подмен. Ручные подмены доступны.', 'error')
}

function replacementUrl(value: unknown, template?: string): string | undefined {
    if (typeof value !== 'string' && typeof value !== 'number') return
    const input = String(value).trim()
    if (!input) return
    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input)
    const hasHost = input.startsWith('//') || /^[\w-]+(?:\.[\w-]+)+(?=[/:?#])/.test(input)
    const url = hasScheme || hasHost ? input : template?.replace('%%', input)
    if (!url) return
    const parsed = URL.parse(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : 'https://' + url.replace(/^\/\//, ''))
    if (parsed && (parsed.protocol === 'https:' || parsed.protocol === 'http:') && !parsed.username && !parsed.password) return parsed.href
}

function mergeIntoMap<T>(target: Map<string, T>, source?: Record<string, T> | Map<string, T>) {
    if (!source) return
    const entries = source instanceof Map ? source.entries() : Object.entries(source)
    for (const [key, value] of entries) {
        if (!target.has(key)) {
            target.set(key, value)
        }
    }
}

class MinifiedRemoteSource {
    tracks: Map<string, Track> = new Map()
    albums: Map<string, Album> = new Map()
    artists: Map<string, Artist> = new Map()
    artistsInsertions: Map<string, ArtistInsertions> = new Map()
    replacements = new Map<string, string>()

    public constructor(list: RemoteList) {
        for (const source of list.sources) {
            if (source.supportedVersions && !versionsSatisfies(addonConfig.version, source.supportedVersions)) continue

            mergeIntoMap(this.tracks, source.tracks)
            mergeIntoMap(this.albums, source.albums)
            mergeIntoMap(this.artists, source.artists)
            mergeIntoMap(this.artistsInsertions, source.artistsInsertions)

            if (!Array.isArray(source.tracksStorages)) continue
            const replacements = new Map<string, string>()
            for (const storage of source.tracksStorages) {
                if (!storage) continue
                const add = (id: string, value: unknown, durationMs?: number) => {
                    if (!id.trim()) return
                    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs > 0) {
                        this.tracks.set(id, { ...this.tracks.get(id), durationMs } as Track)
                    }
                    const url = replacementUrl(value, storage.urlTemplate)
                    if (url && !replacements.has(id)) replacements.set(id, url)
                }

                for (const [id, entry] of Object.entries(storage.tracks ?? {})) {
                    if (entry && typeof entry === 'object') add(id, entry.url, entry.durationMs)
                    else add(id, entry)
                }
                if (Array.isArray(storage.trackIds)) {
                    for (const entry of storage.trackIds) {
                        if (typeof entry === 'number') add(String(entry), entry)
                        else if (entry && typeof entry.id === 'number') add(String(entry.id), entry.id, entry.durationMs)
                    }
                }
            }
            for (const [id, url] of replacements) this.replacements.set(id, url)
        }

        postProcess(this.artistsInsertions, this.tracks, this.albums)
    }
}

class RemoteSource extends Source {
    constructor(private readonly catalog: MinifiedRemoteSource) {
        super()
    }

    getKnownIds(type: SpoofableType): Iterable<string> {
        if (type === 'album') return this.catalog.albums.keys()
        if (type === 'artist') return new Set([...this.catalog.artists.keys(), ...this.catalog.artistsInsertions.keys()])
        return new Set([...this.catalog.tracks.keys(), ...this.catalog.replacements.keys()])
    }

    async buildPlayerReplacement(trackId: string): Promise<TrackReplacement | null> {
        const url = this.catalog.replacements.get(trackId)
        return url ? new TrackReplacement(this, url) : null
    }

    hasPlayerReplacement(trackId: string): boolean | null {
        return this.catalog.replacements.has(trackId) ? true : null
    }

    getTrackSpoof(trackId: string): Track | null {
        return this.catalog.tracks.get(trackId) ?? null
    }

    getAlbumSpoof(albumId: string): Album | null {
        return this.catalog.albums.get(albumId) ?? null
    }

    getArtistSpoof(artistId: string): Artist | null {
        return this.catalog.artists.get(artistId) ?? null
    }

    getArtistInsertions(artistId: string): ArtistInsertions | null {
        return this.catalog.artistsInsertions.get(artistId) ?? null
    }
}
