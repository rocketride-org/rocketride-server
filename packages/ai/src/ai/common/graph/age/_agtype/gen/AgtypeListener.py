# Generated from Agtype.g4 by ANTLR 4.13.2
from antlr4 import *
if "." in __name__:
    from .AgtypeParser import AgtypeParser
else:
    from AgtypeParser import AgtypeParser

# This class defines a complete listener for a parse tree produced by AgtypeParser.
class AgtypeListener(ParseTreeListener):

    # Enter a parse tree produced by AgtypeParser#agType.
    def enterAgType(self, ctx:AgtypeParser.AgTypeContext):
        pass

    # Exit a parse tree produced by AgtypeParser#agType.
    def exitAgType(self, ctx:AgtypeParser.AgTypeContext):
        pass


    # Enter a parse tree produced by AgtypeParser#agValue.
    def enterAgValue(self, ctx:AgtypeParser.AgValueContext):
        pass

    # Exit a parse tree produced by AgtypeParser#agValue.
    def exitAgValue(self, ctx:AgtypeParser.AgValueContext):
        pass


    # Enter a parse tree produced by AgtypeParser#StringValue.
    def enterStringValue(self, ctx:AgtypeParser.StringValueContext):
        pass

    # Exit a parse tree produced by AgtypeParser#StringValue.
    def exitStringValue(self, ctx:AgtypeParser.StringValueContext):
        pass


    # Enter a parse tree produced by AgtypeParser#IntegerValue.
    def enterIntegerValue(self, ctx:AgtypeParser.IntegerValueContext):
        pass

    # Exit a parse tree produced by AgtypeParser#IntegerValue.
    def exitIntegerValue(self, ctx:AgtypeParser.IntegerValueContext):
        pass


    # Enter a parse tree produced by AgtypeParser#FloatValue.
    def enterFloatValue(self, ctx:AgtypeParser.FloatValueContext):
        pass

    # Exit a parse tree produced by AgtypeParser#FloatValue.
    def exitFloatValue(self, ctx:AgtypeParser.FloatValueContext):
        pass


    # Enter a parse tree produced by AgtypeParser#TrueBoolean.
    def enterTrueBoolean(self, ctx:AgtypeParser.TrueBooleanContext):
        pass

    # Exit a parse tree produced by AgtypeParser#TrueBoolean.
    def exitTrueBoolean(self, ctx:AgtypeParser.TrueBooleanContext):
        pass


    # Enter a parse tree produced by AgtypeParser#FalseBoolean.
    def enterFalseBoolean(self, ctx:AgtypeParser.FalseBooleanContext):
        pass

    # Exit a parse tree produced by AgtypeParser#FalseBoolean.
    def exitFalseBoolean(self, ctx:AgtypeParser.FalseBooleanContext):
        pass


    # Enter a parse tree produced by AgtypeParser#NullValue.
    def enterNullValue(self, ctx:AgtypeParser.NullValueContext):
        pass

    # Exit a parse tree produced by AgtypeParser#NullValue.
    def exitNullValue(self, ctx:AgtypeParser.NullValueContext):
        pass


    # Enter a parse tree produced by AgtypeParser#ObjectValue.
    def enterObjectValue(self, ctx:AgtypeParser.ObjectValueContext):
        pass

    # Exit a parse tree produced by AgtypeParser#ObjectValue.
    def exitObjectValue(self, ctx:AgtypeParser.ObjectValueContext):
        pass


    # Enter a parse tree produced by AgtypeParser#ArrayValue.
    def enterArrayValue(self, ctx:AgtypeParser.ArrayValueContext):
        pass

    # Exit a parse tree produced by AgtypeParser#ArrayValue.
    def exitArrayValue(self, ctx:AgtypeParser.ArrayValueContext):
        pass


    # Enter a parse tree produced by AgtypeParser#obj.
    def enterObj(self, ctx:AgtypeParser.ObjContext):
        pass

    # Exit a parse tree produced by AgtypeParser#obj.
    def exitObj(self, ctx:AgtypeParser.ObjContext):
        pass


    # Enter a parse tree produced by AgtypeParser#pair.
    def enterPair(self, ctx:AgtypeParser.PairContext):
        pass

    # Exit a parse tree produced by AgtypeParser#pair.
    def exitPair(self, ctx:AgtypeParser.PairContext):
        pass


    # Enter a parse tree produced by AgtypeParser#array.
    def enterArray(self, ctx:AgtypeParser.ArrayContext):
        pass

    # Exit a parse tree produced by AgtypeParser#array.
    def exitArray(self, ctx:AgtypeParser.ArrayContext):
        pass


    # Enter a parse tree produced by AgtypeParser#typeAnnotation.
    def enterTypeAnnotation(self, ctx:AgtypeParser.TypeAnnotationContext):
        pass

    # Exit a parse tree produced by AgtypeParser#typeAnnotation.
    def exitTypeAnnotation(self, ctx:AgtypeParser.TypeAnnotationContext):
        pass


    # Enter a parse tree produced by AgtypeParser#floatLiteral.
    def enterFloatLiteral(self, ctx:AgtypeParser.FloatLiteralContext):
        pass

    # Exit a parse tree produced by AgtypeParser#floatLiteral.
    def exitFloatLiteral(self, ctx:AgtypeParser.FloatLiteralContext):
        pass



del AgtypeParser