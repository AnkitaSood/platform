import { writeFileSync } from 'fs';
import {
  Project,
  TypeGuards,
  ExportedDeclarations,
  MethodDeclaration,
  SourceFile,
} from 'ts-morph';
import { format, resolveConfig } from 'prettier';

const signatures = {
  ClassDeclaration: formatClassDeclaration,
  FunctionDeclaration: formatFunctionDeclaration,
  VariableDeclaration: formatVariableDeclaration,
  InterfaceDeclaration: formatInterfaceDeclaration,
  TypeAliasDeclaration: formatTypeAliasDeclaration,
  EnumDeclaration: formatEnumDeclaration,
} as {
  [key: string]: (declaration: ExportedDeclarations) => string;
};

generateApi();

function generateApi() {
  const files = getBarrelFiles();
  const output = files
    .map(generateApiForFile)
    .reduce((acc, file) => acc.concat(file), []);
  writeApi(output);
}

function getBarrelFiles() {
  const project = new Project();
  project.addSourceFilesAtPaths('./modules/*/index.ts');
  const files = project.getSourceFiles();
  return files;
}

function generateApiForFile(sourceFile: SourceFile) {
  const module = sourceFile.getDirectory().getBaseName();
  const exportDeclarations = sourceFile.getExportedDeclarations();

  const fileOutput: Output[] = [];
  for (const [key, declarations] of exportDeclarations) {
    fileOutput.push({
      module,
      api: key,
      kind: declarations[0].getKindName(),
      // declaration can have overloads
      // iterate over each overload to document all declarations
      signatures: declarations.map((d) => {
        const formatter =
          signatures[d.getKindName()] ||
          ((declaration) => declaration.getText());
        return formatter(d);
      }),
    });
  }

  return fileOutput;
}

function writeApi(output: Output[]) {
  const code = JSON.stringify(output);
  const prettierConfig = resolveConfig.sync(__dirname);

  const apiOutput = format(code, {
    parser: 'json',
    ...prettierConfig,
  });
  writeFileSync('./output.json', apiOutput, 'utf-8');
}

function formatFunctionDeclaration(declaration: ExportedDeclarations) {
  if (!TypeGuards.isFunctionDeclaration(declaration)) {
    throw Error('Declaration is not a function');
  }

  // we don't want implementation details to be leaked into the API docs
  // for now, removing the body is the simplest thing to do
  // another option would be to generate the signature
  // this would allow us to add links to other API docs?
  declaration.removeBody();
  const signature = declaration.getText().replace('export function', '');
  return removeDoubleSpacesAndLineBreaks(signature).trim();
}

function formatClassDeclaration(declaration: ExportedDeclarations) {
  if (!TypeGuards.isClassDeclaration(declaration)) {
    throw Error('Declaration is not a class');
  }

  // build the class signature
  let classNameText = declaration.getName();

  const typesText = declaration
    .getTypeParameters()
    .map((p) => removeDoubleSpacesAndLineBreaks(p.getText()))
    .join(', ');

  const extendsText = removeDoubleSpacesAndLineBreaks(
    declaration.getExtends()?.getText() ?? ''
  );

  const implementsText = declaration
    .getImplements()
    .map((impl) => removeDoubleSpacesAndLineBreaks(impl.getText()))
    .join(', ');

  const methodsText = declaration
    .getMethods()
    .map(formatMethodText)
    .filter(Boolean)
    .join('\r\n');

  // concat class parts to build the signature
  let signature = `class ${classNameText}`;

  if (typesText) {
    signature += `<${typesText}>`;
  }

  if (extendsText) {
    signature += ` extends ${extendsText}`;
  }

  if (implementsText) {
    signature += ` implements ${implementsText}`;
  }

  if (methodsText) {
    signature += ` {\r\n${methodsText}\r\n}`;
  } else {
    signature += ' { }';
  }

  return signature.trim();

  function formatMethodText(method: MethodDeclaration) {
    // if a method doesn't have a scope, ts-morph returns `public`
    if (method.getScope() !== 'public') return;

    // here again, we could build the signature ourselves
    // removing the body is simpler for now
    method.removeBody();
    return method.getText();
  }
}

function formatVariableDeclaration(declaration: ExportedDeclarations) {
  if (!TypeGuards.isVariableDeclaration(declaration)) {
    throw Error('Declaration is not a variable');
  }

  const nameText = declaration.getName();
  const typeText = declaration.getType().getText(declaration);

  return `const ${nameText}: ${typeText}`;
}

function formatTypeAliasDeclaration(declaration: ExportedDeclarations) {
  if (!TypeGuards.isTypeAliasDeclaration(declaration)) {
    throw Error('Declaration is not a type alias');
  }

  return declaration.getText().replace('export', '').trim();
}

function formatEnumDeclaration(declaration: ExportedDeclarations) {
  if (!TypeGuards.isEnumDeclaration(declaration)) {
    throw Error('Declaration is not an enum');
  }

  // keep enum as is
  // this also adds the comments, do we want this?
  return declaration.getText();
}

function formatInterfaceDeclaration(declaration: ExportedDeclarations) {
  if (!TypeGuards.isInterfaceDeclaration(declaration)) {
    throw Error('Declaration is not an interface');
  }

  const interfaceNameText = declaration.getName();

  const typesText = declaration
    .getTypeParameters()
    .map((p) => removeDoubleSpacesAndLineBreaks(p.getText()))
    .join(', ');

  const ownPropertiesText = declaration
    .getProperties()
    .map((p) => removeDoubleSpacesAndLineBreaks(p.getText()));

  // should this be recursive?
  const extendedPropertiesText = declaration
    .getBaseDeclarations()
    .map((b) =>
      TypeGuards.isInterfaceDeclaration(b)
        ? [
            ``,
            `// inherited from ${b.getName()}`,
            ...b
              .getProperties()
              .map((p) => removeDoubleSpacesAndLineBreaks(p.getText())),
          ]
        : []
    )
    .reduce((props, prop) => props.concat(prop), []);

  const propertiesText = ownPropertiesText
    .concat(extendedPropertiesText)
    .join('\r\n');

  // concat interface parts to build the signature
  let signature = `interface ${interfaceNameText}`;

  if (typesText) {
    signature += `<${typesText}>`;
  }

  if (propertiesText) {
    signature += ` {\r\n${propertiesText}\r\n}`;
  } else {
    signature += ' {}';
  }

  return signature;
}

function removeDoubleSpacesAndLineBreaks(text: string, replacer = ' ') {
  return text.replace(/\s\s+/g, replacer);
}

interface Output {
  module: string;
  api: string;
  kind: string;
  signatures: string[];
}
