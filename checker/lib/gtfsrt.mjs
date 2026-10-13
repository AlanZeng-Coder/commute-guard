import GtfsRealtimeBindings from 'gtfs-realtime-bindings';

const { FeedMessage } = GtfsRealtimeBindings.transit_realtime;

/** Decode a GTFS-Realtime protobuf into a plain object (camelCase fields, enum names, numeric longs). */
export function decodeFeed(bytes) {
  const msg = FeedMessage.decode(bytes);
  return FeedMessage.toObject(msg, { longs: Number, enums: String, defaults: false, arrays: true });
}
