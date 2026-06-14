# Player UI Time Control

All time operations belong in Player UI. Scene Inspector and component controls can edit settings, but they must not become separate play/pause/seek/reset surfaces.

Player UI owns:

- Clock Mode switching
- play / pause
- seek / reset
- playbackRate
- shared controller request / release
- local preview reset
- selected ObjectAge display

## Local Preview

Editor Shell uses Local Preview by default.

Display:

```txt
Local Preview
自分だけに反映
```

Operations affect only the current client. Objects still animate, run Loomlet graphs, and simulate physics immediately after placement or setting changes; the Player UI is a controller for pausing, resetting, seeking, or slow checking, not a required start button.

## Shared Playback

Shared Playback synchronizes controller operations, not the controller's frame-by-frame local clock.

Controller display:

```txt
Shared Playback
Controller: Akihiro
全員に反映
```

Follower display:

```txt
Shared Playback
Following Akihiro
```

Followers cannot play, pause, seek, reset, or change rate until they take control. Controller transfer adopts the currently displayed SharedTime and publishes the next shared operation against `RoomNow * rate + sharedOffset`.

## Room Time

Room Time follows RoomNow.

Display:

```txt
Room Time
現在時刻に同期
```

Pause and seek are disabled or hidden in this mode because the mode represents current room time, not a transport timeline.
