// 当前格式尚未发布，读写端共用一个常量，避免调整活动 chunk 时产生不可读取的数据。
export const CANONICAL_TIMELINE_CHUNK_SIZE = 32;
