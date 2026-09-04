export type FieldShape = {
  name: string;
  points: Array<[number, number]>;
};

export type CaseDefinition = {
  id: string;
  name: string;
  color: string;
  fields: FieldShape[];
  missingFields: string[];
};

export type RegionInstance = {
  id: string;
  caseId: string;
  start: number;
  end: number;
  visible: boolean;
};

const CASE_COLORS = ['#ff6b57', '#52d6ff', '#ffd166', '#9b8cff'];

function parseXml(source: string) {
  const document = new DOMParser().parseFromString(source, 'application/xml');
  const error = document.querySelector('parsererror');
  if (error) throw new Error('区域配置 XML 格式无效');
  return document;
}

export function getConfigContentId(source: string) {
  const document = parseXml(source.replace(/^\uFEFF/, ''));
  return document.querySelector('FileInfo > ContentId')?.textContent?.trim() ?? '';
}

function directChild(element: Element, tagName: string) {
  return Array.from(element.children).find((child) => child.tagName === tagName) ?? null;
}

function text(element: Element, tagName: string, fallback = '') {
  return directChild(element, tagName)?.textContent?.trim() ?? fallback;
}

function parseFieldShapes(fieldsXml: string) {
  const document = parseXml(fieldsXml);
  const result = new Map<string, FieldShape>();

  for (const fieldset of Array.from(document.querySelectorAll('Fieldsets > Fieldset'))) {
    const field = directChild(fieldset, 'Field');
    if (!field) continue;
    const name = field.getAttribute('Name') ?? fieldset.getAttribute('Name') ?? 'Field';
    const polygon = directChild(field, 'Polygon');
    const rectangle = directChild(field, 'Rectangle');
    let points: Array<[number, number]> = [];

    if (polygon) {
      points = Array.from(polygon.children)
        .filter((child) => child.tagName === 'Point')
        .map((point) => [
          Number(point.getAttribute('X')) / 1000,
          Number(point.getAttribute('Y')) / 1000,
        ]);
    } else if (rectangle) {
      const centerX = Number(rectangle.getAttribute('OriginX')) / 1000;
      const centerY = Number(rectangle.getAttribute('OriginY')) / 1000;
      const width = Number(rectangle.getAttribute('Width')) / 1000;
      const height = Number(rectangle.getAttribute('Height')) / 1000;
      const rotation = Number(rectangle.getAttribute('Rotation') ?? 0) * Math.PI / 180;
      const corners: Array<[number, number]> = [
        [-width / 2, -height / 2],
        [width / 2, -height / 2],
        [width / 2, height / 2],
        [-width / 2, height / 2],
      ];
      points = corners.map(([x, y]) => [
        centerX + x * Math.cos(rotation) - y * Math.sin(rotation),
        centerY + x * Math.sin(rotation) + y * Math.cos(rotation),
      ]);
    }

    if (points.length >= 3) result.set(name, { name, points });
  }
  return result;
}

export function parseRegionConfig(casesXml: string, fieldsXml: string): CaseDefinition[] {
  const casesDocument = parseXml(casesXml);
  const root = casesDocument.documentElement;
  const mainCases = directChild(root, 'Cases');
  const evals = directChild(root, 'Evals');
  const fieldsConfiguration = directChild(root, 'FieldsConfiguration');
  if (!mainCases || !evals || !fieldsConfiguration) throw new Error('Case table 缺少必要节点');

  const fieldNames = new Map<string, string>();
  for (const userField of Array.from(fieldsConfiguration.querySelectorAll('UserField'))) {
    const id = userField.getAttribute('Id');
    const name = text(userField, 'Name');
    if (id && name) fieldNames.set(id, name);
  }

  const shapesByName = parseFieldShapes(fieldsXml);
  const caseRows = Array.from(mainCases.children)
    .filter((child) => child.tagName === 'Case')
    .map((element) => ({
      element,
      order: Number(text(element, 'DisplayOrder', '0')),
    }))
    .sort((a, b) => a.order - b.order);

  return caseRows.map(({ element, order }, index) => {
    const fieldIds = new Set<string>();
    for (const evaluation of Array.from(evals.children).filter((child) => child.tagName === 'Eval')) {
      const evalCases = directChild(evaluation, 'Cases');
      const evalCase = evalCases
        ? Array.from(evalCases.children).find(
            (candidate) => candidate.tagName === 'Case' && candidate.getAttribute('Id') === String(order)
          )
        : null;
      const fieldId = evalCase?.querySelector('UserFieldId')?.textContent?.trim();
      if (fieldId) fieldIds.add(fieldId);
    }

    const referencedFieldNames = Array.from(fieldIds)
      .map((id) => fieldNames.get(id))
      .filter((name): name is string => Boolean(name));
    const fields = referencedFieldNames
      .map((name) => shapesByName.get(name))
      .filter((shape): shape is FieldShape => Boolean(shape));
    const missingFields = referencedFieldNames.filter((name) => !shapesByName.has(name));

    return {
      id: element.getAttribute('Id') ?? String(order),
      name: text(element, 'Name', `Case ${order + 1}`),
      color: CASE_COLORS[index % CASE_COLORS.length],
      fields,
      missingFields,
    };
  });
}
