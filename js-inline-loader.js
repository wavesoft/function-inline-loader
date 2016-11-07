const esprima = require('esprima');
const escodegen = require('escodegen');
const fs = require("fs");
const path = require("path");

const MACRO = /%inline\s*\(\s*["'](.*?)['"]\s*\)\s*\.\s*(\w+)\s*\((\s*\))?/g;

/**
 * This function walks the given module AST and tries to locate all the
 * functions it exports.
 *
 * @param {Object} ast - The AST as parsed by esprima
 * @returns {Object} Returns a key/value object with the names and the AST of all exported functions
 */
function getExportedFunctions(ast) {
  var functions =  ast.body.reduce(function(scopeFunctions, node) {

    //
    // Look for ES6 `export` functions
    //
    // export function name(a,b,c) {
    //   ...
    // }
    //
    if (node.type === 'ExportNamedDeclaration') {
      if (node.declaration.type === 'FunctionDeclaration') {
        scopeFunctions[node.declaration.id.name] = {
          exported: true,
          ast: node.declaration
        };
      }
      return scopeFunctions;
    }

    //
    // Look for regular function declarations
    //
    // function name(a,b,c) {
    //   ...
    // }
    //
    if (node.type === 'FunctionDeclaration') {
      scopeFunctions[node.id.name] = {
        exported: false,
        ast: node
      };
      return scopeFunctions;
    }

    //
    // Look for variable-defined function declarations
    //
    // var name = function(a,b,c) {
    //   ...
    // }
    //
    if (node.type === 'VariableDeclaration') {
      node.declarations.forEach(function(node) {
        if (node.init.type === 'FunctionExpression') {
          scopeFunctions[node.id.name] = {
            exported: false,
            ast: node.init
          };
        }
      });
      return scopeFunctions;
    }

    //
    // Look for default-class export with static functions
    //
    // export default class {
    //    static name(a,b,c) {
    //       ...
    //    }
    // }
    //
    if ((node.type === 'ExportDefaultDeclaration') &&
        (node.declaration.type === 'ClassDeclaration')) {

      node.declaration.body.body.forEach(function(node) {
        if ((node.type === 'MethodDefinition') && node.static) {
          scopeFunctions[node.key.name] = {
            exported: true,
            ast: node.value
          };
        }
      });

      return scopeFunctions;
    }

    //
    // Look for CommonJs exports
    //
    // module.exports = {
    //    name: function(a,b,c) {
    //      ...
    //    },
    //    name(a,b,c) {
    //      ...
    //    },
    //    reference_to_other_function
    // }
    //
    if ((node.type === 'ExpressionStatement') &&
        (node.expression.left.type === 'MemberExpression') &&
        (node.expression.left.object.name === 'module') &&
        (node.expression.left.property.name === 'exports') &&
        (node.expression.right.type === 'ObjectExpression')) {

      node.expression.right.properties.forEach(function(node) {
        var name = node.key.name;
        var value = node.value;

        // Mark reference to declared functions as exported
        if ((value.type === 'Identifier') && (scopeFunctions[value.name] !== undefined)) {
          if (name === value.name) {
            scopeFunctions[name].exported = true;
          } else {
            scopeFunctions[name] = {
              exported: true,
              ast: scopeFunctions[value.name].ast
            }
          }
          return;
        }

        // Keep reference to in-place defined functions
        if (value.type === 'FunctionExpression') {
          scopeFunctions[name] = {
            exported: true,
            ast: value
          };
        }

      });

      return scopeFunctions;
    }

    return scopeFunctions;
  }, {});

  // Keep only the AST of known functions
  return Object.keys(functions).reduce(function(exportedFunc, name) {
    var fn = functions[name];
    if (fn.exported) {
      exportedFunc[name] = fn.ast;
    }
    return exportedFunc;
  }, {});
}

/**
 * Render the body of the function as a program
 *
 * @param {Object} ast - The function AST
 * @returns {String} Returns the rendered function body
 */
function renderFunction(ast) {

  // Empty functions have empty contents
  if (ast.body.body.length === 0) {
    return '';
  }

  // Functions that have only a return statement, skip the 'return' and
  // render only it's value
  if (ast.body.body[0].type === 'ReturnStatement') {
    return escodegen.generate(ast.body.body[0].argument);
  }

  // Otherwise render the function body as a program fragment
  return escodegen.generate({
    type: 'Program',
    body: ast.body.body,
    sourceType: 'script'
  });

}

/**
 * Replace any identifier AST node found in the tree with a replacement node
 * given in the `withAst` argument.
 *
 * This function also checks if the identifier is shadowed at some particular
 * path of the AST and if yes, it does not replace it.
 *
 * @param {String} name - The name of the identifier
 * @param {Object} withAst - The AST node to replace with
 * @param {Object} inAst - The AST tree to search within
 * @returns {Object} Returns the modified AST.
 */
function replaceIdentifier(name, withAst, inAst) {
  if ((inAst.type === 'Identifier') && (inAst.name === name)) {
    return withAst;
  }

  // If we have a VariableDeclaration that shadows the given identifier
  // in the current body scope, pass the current contents as-is
  if (Array.isArray(inAst.body)) {
    var isShadowed = false;
    inAst.body.forEach(function(node) {

      //
      // Variable declarations can shadow this identifier
      //
      // var name = ...
      //
      if (node.type === 'VariableDeclaration') {
        node.declarations.forEach(function(node) {
          if (node.id.name === name) {
            isShadowed = true;
          }
        });
      }

      //
      // For statements can also shadow this identifier
      //
      // for (var name = ... ; ; ) {
      //
      if (node.type === 'ForStatement') {
        if (node.init && (node.init.type === 'VariableDeclaration')) {
          node.init.declarations.forEach(function(node) {
            if (node.id.name === name) {
              isShadowed = true;
            }
          });
        }
      }

    });

    // If we are shadowed we cannot do more
    if (isShadowed) {
      return inAst;
    }
  }

  // Recursively replace identifiers in the tree
  return Object.keys(inAst).reduce(function(newAst, key) {
    var value = inAst[key];

    if (Array.isArray(value)) {
      newAst[key] = value.map(replaceIdentifier.bind({}, name, withAst));
    } else if ((typeof value === 'object') && (value !== null)) {
      newAst[key] = replaceIdentifier(name, withAst, value);
    } else {
      newAst[key] = value;
    }

    return newAst;
  }, {});
}

/**
 * Compile the ASTs for the specified arguments expression
 *
 * @param {String} expression - The javascript expression for which to compile an AST
 * @returns {Arrays} Returns the array of the arguments as ASTs
 */
function compileArgumentAst(argsExpression) {
  return esprima.parse('X('+argsExpression+')')
    .body[0].expression.arguments;
}

/**
 * Load module contents, trying the various different extensions defined in the
 *
 * @param {String} modulePath - The path to the module
 * @param {Object} options - The webpack options from wihch to extract extensions
 * @returns {String} Returns the file contents
 */
function loadModuleContents(modulePath, options) {
  var extensions = options && options.resolve && options.resolve.extensions || [ '', '.js' ];
  return extensions.reduce(function(payload, ext) {

    // Pass-down payload if found
    if (payload !== null) {
      return payload;
    }

    // Load contents or null on loading error
    try {
      return fs.readFileSync(modulePath + ext);
    } catch(e) {
      return null;
    }

  }, null);
}

/**
 * Return the inline contents of the given function from the given module with
 * the given argument string.
 *
 * @this {loaderAPI} The function should be bound to the webpack loader API
 * @param {String} gModule - The module that contains the actions
 * @param {String} gFunction - The module function to inline
 * @param {String} gArgs - The arguments passed to the inline function
 * @returns {String} Returns the generated code for this inline function
 */
function getFunctionCode(gModule, gFunction, fnArgs) {
  // Resolve filename
  var filePath = path.resolve(this.context, gModule);
  var contents = loadModuleContents(filePath, this.options);
  if (!contents) {
    this.emitError('Could not find module `' + gModule + '`');
    return '/* Missing module ' + gModule + ' */';
  }

  // Load file and extract AST
  var ast;
  try {
    ast = esprima.parse(contents, { sourceType: 'module' })
  } catch (e) {
    this.emitError('%inline("' + gModule + '"): ' + e.toString());
    return '/* Parsing error in module ' + gModule + ' */';
  }
  this.addDependency(filePath);

  // Locate the correct function AST
  var exportedFn = getExportedFunctions(ast);
  var fnAst = exportedFn[gFunction];
  if (!fnAst) {
    this.emitError('%inline("' + gModule + '"): Undefined function `' + gFunction);
    return '/* Unknown inline ' + gFunction + ' */';
  }

  // Replace arguments in the function ast
  for (var i=0; i<fnArgs.length; ++i) {
    fnAst = replaceIdentifier( fnAst.params[i].name, fnArgs[i], fnAst );
  }

  // Render contents
  return renderFunction(fnAst);
}

/**
 * This function walks the AST and returns the node that calls the magic
 * inline function `___js_inline_loader_inline`.
 *
 * @param {Object} ast - The AST to walk
 * @returns {Object} Returns the AST node of the magic function
 */
function findInlineToken(ast) {
  if ((ast.type === 'CallExpression') && (ast.callee.name === '___js_inline_loader_inline')) {
    return ast;
  }

  // Walk object properties
  var keys = Object.keys(ast);
  for (var i=0, l=keys.length; i<l; ++i) {
    var key = keys[i];
    var value = ast[key];

    // Process each item of an array
    if (Array.isArray(value)) {
      for (var j=0, jl=value.length; j<jl; ++j) {
        if (typeof value[j] === 'object') {
          var ans = findInlineToken(value[j]);
          if (ans) return ans;
        }
      }

    // And forward the checks of the objects
    } else if ((typeof value === 'object') && (value !== null)) {
      var ans = findInlineToken(value);
      if (ans) return ans;

    }
  }

  // Nothing found
  return null;
}

/**
 * Correct replacement of an `%inline` macro, using AST processing
 *
 * This function is rather slow, since we are parsing the entire AST every time
 * we replace something in the source. This way, the resulting source code
 * maintains it's comments and any other information that the esprima parser
 * did not understand.
 *
 * However a much faster alternative would be to parse the AST only once and
 * then replace the ast nodes of the inline functions with the AST nodes
 * from the imported modules.
 *
 * @param {String} source - The source code to proess
 * @param {Function} callback - The callback to use to get replacements
 * @returns {String} Returns the new source
 */
function replaceInlineFunc(source, callback) {
  while (true) {
    var ast;

    // Parse the current source into the AST
    try {
      ast = esprima.parse(source, {sourceType: 'module', range: true});
    } catch (e) {
      this.emitError('Inline processing failed: SyntaxError: ' + e.toString());
      return source;
    }

    // Find an the next inline token to replace
    var token = findInlineToken(ast);
    if (!token) {
      return source;
    }

    // Callback with details and get the replacement
    var replacement = callback(
      token.arguments[0].value, // Module
      token.arguments[1].name,  // Function
      token.arguments.slice(2)  // Arguments as AST nodes
    );

    // Replace that part of the source with the generated one
    source = source.substring(0, token.range[0]) + replacement +
             source.substring(token.range[1]);

  }
}

/**
 * Export the webpack replace function
 */
module.exports = function(source) {
  this.cacheable();

  // Convert the convenient `%inline` macro to a proper JS expression
  var hasMacros = false;
  var normSource = source.replace(MACRO, function(m, gModule, gFunction, gEmpty) {
    hasMacros = true;
    return '___js_inline_loader_inline(\'' + gModule + '\',' + gFunction + (gEmpty ? ')' : ',');
  });

  // If we don't have any macros, don't spend more cycles on processing the code
  if (!hasMacros) {
    return source;
  }

  // Replace all inline functions using the AST
  return replaceInlineFunc.call(this, normSource, getFunctionCode.bind(this));
};
