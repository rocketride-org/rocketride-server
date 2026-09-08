# Licensed to the Apache Software Foundation (ASF) under one
# or more contributor license agreements.  See the NOTICE file
# distributed with this work for additional information
# regarding copyright ownership.  The ASF licenses this file
# to you under the Apache License, Version 2.0 (the
# "License"); you may not use this file except in compliance
# with the License.  You may obtain a copy of the License at
# http://www.apache.org/licenses/LICENSE-2.0
# Unless required by applicable law or agreed to in writing,
# software distributed under the License is distributed on an
# "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
# KIND, either express or implied.  See the License for the
# specific language governing permissions and limitations
# under the License.
from . import gen
from .gen.AgtypeLexer import AgtypeLexer
from .gen.AgtypeParser import AgtypeParser
from .gen.AgtypeVisitor import AgtypeVisitor
from .models import *
from .exceptions import *
from antlr4 import InputStream, CommonTokenStream, ParserRuleContext
from antlr4.tree.Tree import TerminalNode
from decimal import Decimal
import json

resultHandler = None

class ResultHandler:
    def parse(ageData):
        pass

def newResultHandler(query=""):
    resultHandler = Antlr4ResultHandler(None, query)
    return resultHandler

def parseAgeValue(value, cursor=None):
    if value is None:
        return None

    global resultHandler
    if (resultHandler == None):
        resultHandler = Antlr4ResultHandler(None)
    try:
        return resultHandler.parse(value)
    except Exception as ex:
        raise AGTypeError(value, ex)


class Antlr4ResultHandler(ResultHandler):
    def __init__(self, vertexCache, query=None):
        self.lexer = AgtypeLexer()
        self.parser = AgtypeParser(None)
        self.visitor = ResultVisitor(vertexCache)

    def parse(self, ageData):
        if not ageData:
            return None
        # print("Parse::", ageData)

        self.lexer.inputStream = InputStream(ageData)
        self.parser.setTokenStream(CommonTokenStream(self.lexer))
        self.parser.reset()
        tree = self.parser.agType()
        parsed = tree.accept(self.visitor)
        return parsed


# print raw result String
class DummyResultHandler(ResultHandler):
    def parse(self, ageData):
        print(ageData)

# default agType visitor
class ResultVisitor(AgtypeVisitor):
    vertexCache = None

    def __init__(self, cache) -> None:
        super().__init__()
        self.vertexCache = cache

    
    def visitAgType(self, ctx:AgtypeParser.AgTypeContext):
        agVal = ctx.agValue()
        if agVal != None:
            obj = ctx.agValue().accept(self)
            return obj

        return None

    def visitAgValue(self, ctx:AgtypeParser.AgValueContext):
        annoCtx = ctx.typeAnnotation()
        valueCtx = ctx.value()

        if annoCtx is not None:
            annoCtx.accept(self)
            identNode = annoCtx.IDENT()
            if identNode is None:
                raise AGTypeError(ctx.getText(), "Missing type annotation identifier")
            anno = identNode.getText()
            if valueCtx is None:
                raise AGTypeError(ctx.getText(), "Missing value for annotated type")
            return self.handleAnnotatedValue(anno, valueCtx)
        else:
            if valueCtx is None:
                return None
            return valueCtx.accept(self)


    @staticmethod
    def _stripStringDelimiters(stringToken):
        # The Agtype STRING token follows the JSON string grammar exactly
        # (surrounding '"' plus \-escapes incl. \uXXXX), so json.loads both
        # strips the delimiters and decodes the escapes — slicing alone would
        # return 'a\\nb' as a literal backslash-n.
        return json.loads(stringToken.getText())

    # Visit a parse tree produced by AgtypeParser#StringValue.
    def visitStringValue(self, ctx:AgtypeParser.StringValueContext):
        return self._stripStringDelimiters(ctx.STRING())


    # Visit a parse tree produced by AgtypeParser#IntegerValue.
    def visitIntegerValue(self, ctx:AgtypeParser.IntegerValueContext):
        return int(ctx.INTEGER().getText())

    # Visit a parse tree produced by AgtypeParser#floatLiteral.
    def visitFloatLiteral(self, ctx:AgtypeParser.FloatLiteralContext):
        text = ctx.getText()
        c = ctx.getChild(0)
        if c is None or not hasattr(c, 'symbol') or c.symbol is None:
            raise AGTypeError(
                str(text),
                "Malformed float literal: missing or invalid child node"
            )
        tp = c.symbol.type
        if tp == AgtypeParser.RegularFloat:
            return float(text)
        elif tp == AgtypeParser.ExponentFloat:
            return float(text)
        else:
            if text == 'NaN':
                return float('nan')
            elif text == '-Infinity':
                return float('-inf')
            elif text == 'Infinity':
                return float('inf')
            else:
                raise ValueError("Unknown float expression: " + text)
        

    # Visit a parse tree produced by AgtypeParser#TrueBoolean.
    def visitTrueBoolean(self, ctx:AgtypeParser.TrueBooleanContext):
        return True


    # Visit a parse tree produced by AgtypeParser#FalseBoolean.
    def visitFalseBoolean(self, ctx:AgtypeParser.FalseBooleanContext):
        return False


    # Visit a parse tree produced by AgtypeParser#NullValue.
    def visitNullValue(self, ctx:AgtypeParser.NullValueContext):
        return None


    # Visit a parse tree produced by AgtypeParser#obj.
    def visitObj(self, ctx:AgtypeParser.ObjContext):
        obj = dict()
        for c in ctx.getChildren():
            if isinstance(c, AgtypeParser.PairContext):
                namVal = self.visitPair(c)
                name = namVal[0]
                valCtx = namVal[1]
                # visitPair() raises AGTypeError when the value node is
                # missing, so valCtx should never be None here.  The
                # guard is kept as a defensive fallback only.
                if valCtx is not None:
                    val = valCtx.accept(self) 
                    obj[name] = val
                else:
                    obj[name] = None
        return obj


    # Visit a parse tree produced by AgtypeParser#pair.
    def visitPair(self, ctx:AgtypeParser.PairContext):
        self.visitChildren(ctx)
        strNode = ctx.STRING()
        agValNode = ctx.agValue()
        if strNode is None:
            raise AGTypeError(ctx.getText(), "Missing key in object pair")
        if agValNode is None:
            raise AGTypeError(ctx.getText(), "Missing value in object pair")
        return (self._stripStringDelimiters(strNode), agValNode)


    # Visit a parse tree produced by AgtypeParser#array.
    def visitArray(self, ctx:AgtypeParser.ArrayContext):
        li = list()
        for c in ctx.getChildren():
            if not isinstance(c, TerminalNode):
                val = c.accept(self)
                li.append(val)
        return li

    def handleAnnotatedValue(self, anno:str, ctx:ParserRuleContext):
        # Each branch below constructs a model object (Vertex, Edge, Path)
        # and populates it from the parsed dict/list.  If a type check
        # fails (e.g. the parsed value is not a dict), AGTypeError is
        # raised and the partially-constructed object is discarded — no
        # cleanup is needed because the caller propagates the exception.
        if anno == "numeric":
            return Decimal(ctx.getText())
        elif anno == "vertex":
            d = ctx.accept(self)
            if not isinstance(d, dict):
                raise AGTypeError(str(ctx.getText()), "Expected dict for vertex, got " + type(d).__name__)
            vid = d.get("id")
            vertex = None
            if self.vertexCache is not None and vid in self.vertexCache:
                vertex = self.vertexCache[vid]
            else:
                vertex = Vertex()
                vertex.id = d.get("id")
                vertex.label = d.get("label")
                vertex.properties = d.get("properties") or {}
            
            if self.vertexCache is not None:
                self.vertexCache[vid] = vertex

            return vertex
        
        elif anno == "edge":
            edge = Edge()
            d = ctx.accept(self)
            if not isinstance(d, dict):
                raise AGTypeError(str(ctx.getText()), "Expected dict for edge, got " + type(d).__name__)
            edge.id = d.get("id")
            edge.label = d.get("label")
            edge.end_id = d.get("end_id")
            edge.start_id = d.get("start_id")
            edge.properties = d.get("properties") or {}
            
            return edge

        elif anno == "path":
            arr = ctx.accept(self)
            if not isinstance(arr, list):
                raise AGTypeError(str(ctx.getText()), "Expected list for path, got " + type(arr).__name__)
            path = Path(arr)
            
            return path

        return ctx.accept(self)
