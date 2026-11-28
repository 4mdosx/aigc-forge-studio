// WD14 标签结构化分组（展示用，不影响 caption）。
// 数据源：/tag/item 的 details（name/category/score）。category 来自 selected_tags.csv：
// 0=general 1=artist 3=copyright 4=character 9=rating。general 内部再按词表细分。

export interface TagDetail {
  name: string;
  category: number;
  score: number;
}

export type TagGroupKey =
  | "character"
  | "design"
  | "identity"
  | "clothing"
  | "scene"
  | "pose"
  | "camera"
  | "background"
  | "quality"
  | "artist"
  | "copyright"
  | "other";

export interface TagGroup {
  key: TagGroupKey;
  label: string;
  // 对应训练档位；null 表示各档都会被剥
  tier: "T1" | "T2" | "T3" | null;
  tags: TagDetail[];
}

const CATEGORY = { general: 0, artist: 1, copyright: 3, character: 4, rating: 9 } as const;

// 设计/材质/结构（对齐 runner captionTiers.DESIGN_TAGS）
const DESIGN_TAGS = new Set([
  "mechanical_parts", "mechanical_arms", "mechanical_legs", "mechanical_ears",
  "machinery", "machine", "robot_joints", "cyborg", "android", "prosthesis",
  "prosthetic_leg", "armor", "armoured", "armored", "gauntlets", "armor_plate",
  "metal", "metallic", "gold", "golden", "gold_trim", "glowing", "glow",
  "rigging", "flight_deck", "aircraft", "ship", "weapon", "gun", "sword",
  "cannon", "missile", "turret", "gear", "gears", "sci-fi",
  "science_fiction", "futuristic", "technology", "power_armor", "exoskeleton",
]);

// 姿势/构图前缀（对齐 runner captionTiers.POSE_PREFIXES；景别镜头词已拆到 CAMERA）
const POSE_PREFIXES = [
  "sitting", "standing", "looking_at", "looking_to", "arms_",
  "arm_up", "crossed_legs", "lying", "kneeling", "one_eye_closed",
];

// 场景物件：酒杯/吧台/室内这类道具，跟服装分开，避免「服装与题材」变垃圾桶
const SCENE = new Set([
  "bar", "bar_(place)", "indoors", "outdoors", "inside", "outside",
  "room", "restaurant", "cafe", "bedroom", "classroom", "street", "alley",
  "drinking_glass", "wine_glass", "cocktail_glass", "cup", "bottle",
  "wine_bottle", "beer_bottle", "alcohol", "drink", "bar_stool", "stool",
  "chair", "table", "counter", "bartender", "liquor", "glass", "plate",
]);

// 构图/镜头语言：景别、视角、机位，跟身体姿势分开
const CAMERA = new Set([
  "dutch_angle", "cowboy_shot", "close-up", "close_up", "portrait",
  "full_body", "upper_body", "mid_shot", "wide_shot", "long_shot",
]);
const CAMERA_PREFIXES = ["from_", "camera_", "view_from", "perspective"];

// 人物身份细节（对齐 runner captionTiers.IDENTITY_HINT）
const IDENTITY_HINT = /(?:^|_)(eyes?|hair|iris|pupils?|expression|smile|blush|mouth|ears?|tail|horns?|skin|breasts?|ass|thighs?|clavicle|eyebrows?)$/;

const BACKGROUND = new Set([
  "white_background", "black_background", "gray_background", "grey_background",
  "simple_background", "solid_color_background", "solid_background",
  "transparent_background", "plain_background", "gradient_background",
  "colored_background", "black_border", "border",
]);

const QUALITY = new Set([
  "lowres", "worst_quality", "low_quality", "blurry", "watermark",
  "signature", "username", "artist_name", "text", "error", "monochrome",
  "greyscale", "grayscale",
]);

// 主体人数：单列一组，跟身份词分开，便于看人数
const SUBJECT = /^(1girl|2girls|3girls|multiple_girls|1boy|2boys|multiple_boys|solo|group|no_humans)$/;

const GROUP_META: Record<TagGroupKey, { label: string; tier: TagGroup["tier"] }> = {
  character: { label: "角色", tier: null },
  design: { label: "机械与设计", tier: "T1" },
  identity: { label: "外貌与身份", tier: "T3" },
  clothing: { label: "服装与题材", tier: "T2" },
  scene: { label: "场景物件", tier: null },
  pose: { label: "姿势与动作", tier: null },
  camera: { label: "构图与镜头", tier: null },
  background: { label: "背景", tier: null },
  quality: { label: "画质与噪声", tier: null },
  artist: { label: "画师", tier: null },
  copyright: { label: "作品", tier: null },
  other: { label: "其他", tier: "T2" },
};

function keyOf(detail: TagDetail): TagGroupKey {
  const lc = detail.name.toLowerCase();
  if (detail.category === CATEGORY.character) return "character";
  if (detail.category === CATEGORY.artist) return "artist";
  if (detail.category === CATEGORY.copyright) return "copyright";
  if (detail.category === CATEGORY.rating) return "quality";
  if (BACKGROUND.has(lc)) return "background";
  if (QUALITY.has(lc)) return "quality";
  if (DESIGN_TAGS.has(lc)) return "design";
  // 镜头词优先于姿势：full_body / cowboy_shot 这类景别不再混进姿势组
  if (CAMERA.has(lc) || CAMERA_PREFIXES.some((prefix) => lc.startsWith(prefix))) return "camera";
  if (SCENE.has(lc)) return "scene";
  if (POSE_PREFIXES.some((prefix) => lc.startsWith(prefix))) return "pose";
  if (SUBJECT.test(lc) || IDENTITY_HINT.test(lc)) return "identity";
  return "clothing";
}

const ORDER: TagGroupKey[] = [
  "character", "design", "identity", "clothing", "scene",
  "pose", "camera", "background", "quality", "artist", "copyright", "other",
];

export function groupTags(details: TagDetail[]): TagGroup[] {
  const buckets = new Map<TagGroupKey, TagDetail[]>();
  for (const detail of details) {
    const key = keyOf(detail);
    const bucket = buckets.get(key) ?? [];
    bucket.push(detail);
    buckets.set(key, bucket);
  }
  const groups: TagGroup[] = [];
  for (const key of ORDER) {
    const tags = buckets.get(key);
    if (!tags || tags.length === 0) continue;
    tags.sort((a, b) => b.score - a.score);
    groups.push({ key, ...GROUP_META[key], tags });
  }
  return groups;
}
