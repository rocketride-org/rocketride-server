# Generated from Agtype.g4 by ANTLR 4.13.2
from antlr4 import *
if "." in __name__:
    from .AgtypeParser import AgtypeParser
else:
    from AgtypeParser import AgtypeParser

# This class defines a complete generic visitor for a parse tree produced by AgtypeParser.

class AgtypeVisitor(ParseTreeVisitor):

    # Visit a parse tree produced by AgtypeParser#agType.
    def visitAgType(self, ctx:AgtypeParser.AgTypeContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#agValue.
    def visitAgValue(self, ctx:AgtypeParser.AgValueContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#StringValue.
    def visitStringValue(self, ctx:AgtypeParser.StringValueContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#IntegerValue.
    def visitIntegerValue(self, ctx:AgtypeParser.IntegerValueContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#FloatValue.
    def visitFloatValue(self, ctx:AgtypeParser.FloatValueContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#TrueBoolean.
    def visitTrueBoolean(self, ctx:AgtypeParser.TrueBooleanContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#FalseBoolean.
    def visitFalseBoolean(self, ctx:AgtypeParser.FalseBooleanContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#NullValue.
    def visitNullValue(self, ctx:AgtypeParser.NullValueContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#ObjectValue.
    def visitObjectValue(self, ctx:AgtypeParser.ObjectValueContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#ArrayValue.
    def visitArrayValue(self, ctx:AgtypeParser.ArrayValueContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#obj.
    def visitObj(self, ctx:AgtypeParser.ObjContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#pair.
    def visitPair(self, ctx:AgtypeParser.PairContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#array.
    def visitArray(self, ctx:AgtypeParser.ArrayContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#typeAnnotation.
    def visitTypeAnnotation(self, ctx:AgtypeParser.TypeAnnotationContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by AgtypeParser#floatLiteral.
    def visitFloatLiteral(self, ctx:AgtypeParser.FloatLiteralContext):
        return self.visitChildren(ctx)



del AgtypeParser