# Generated from Cypher.g4 by ANTLR 4.13.2
from antlr4 import *
if "." in __name__:
    from .CypherParser import CypherParser
else:
    from CypherParser import CypherParser

# This class defines a complete generic visitor for a parse tree produced by CypherParser.

class CypherVisitor(ParseTreeVisitor):

    # Visit a parse tree produced by CypherParser#oC_Cypher.
    def visitOC_Cypher(self, ctx:CypherParser.OC_CypherContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Statement.
    def visitOC_Statement(self, ctx:CypherParser.OC_StatementContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Query.
    def visitOC_Query(self, ctx:CypherParser.OC_QueryContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_RegularQuery.
    def visitOC_RegularQuery(self, ctx:CypherParser.OC_RegularQueryContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Union.
    def visitOC_Union(self, ctx:CypherParser.OC_UnionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_SingleQuery.
    def visitOC_SingleQuery(self, ctx:CypherParser.OC_SingleQueryContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_SinglePartQuery.
    def visitOC_SinglePartQuery(self, ctx:CypherParser.OC_SinglePartQueryContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_MultiPartQuery.
    def visitOC_MultiPartQuery(self, ctx:CypherParser.OC_MultiPartQueryContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_UpdatingClause.
    def visitOC_UpdatingClause(self, ctx:CypherParser.OC_UpdatingClauseContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ReadingClause.
    def visitOC_ReadingClause(self, ctx:CypherParser.OC_ReadingClauseContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Match.
    def visitOC_Match(self, ctx:CypherParser.OC_MatchContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Unwind.
    def visitOC_Unwind(self, ctx:CypherParser.OC_UnwindContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Merge.
    def visitOC_Merge(self, ctx:CypherParser.OC_MergeContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_MergeAction.
    def visitOC_MergeAction(self, ctx:CypherParser.OC_MergeActionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Create.
    def visitOC_Create(self, ctx:CypherParser.OC_CreateContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Set.
    def visitOC_Set(self, ctx:CypherParser.OC_SetContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_SetItem.
    def visitOC_SetItem(self, ctx:CypherParser.OC_SetItemContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Delete.
    def visitOC_Delete(self, ctx:CypherParser.OC_DeleteContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Remove.
    def visitOC_Remove(self, ctx:CypherParser.OC_RemoveContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_RemoveItem.
    def visitOC_RemoveItem(self, ctx:CypherParser.OC_RemoveItemContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_InQueryCall.
    def visitOC_InQueryCall(self, ctx:CypherParser.OC_InQueryCallContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_StandaloneCall.
    def visitOC_StandaloneCall(self, ctx:CypherParser.OC_StandaloneCallContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_YieldItems.
    def visitOC_YieldItems(self, ctx:CypherParser.OC_YieldItemsContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_YieldItem.
    def visitOC_YieldItem(self, ctx:CypherParser.OC_YieldItemContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_With.
    def visitOC_With(self, ctx:CypherParser.OC_WithContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Return.
    def visitOC_Return(self, ctx:CypherParser.OC_ReturnContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ProjectionBody.
    def visitOC_ProjectionBody(self, ctx:CypherParser.OC_ProjectionBodyContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ProjectionItems.
    def visitOC_ProjectionItems(self, ctx:CypherParser.OC_ProjectionItemsContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ProjectionItem.
    def visitOC_ProjectionItem(self, ctx:CypherParser.OC_ProjectionItemContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Order.
    def visitOC_Order(self, ctx:CypherParser.OC_OrderContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Skip.
    def visitOC_Skip(self, ctx:CypherParser.OC_SkipContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Limit.
    def visitOC_Limit(self, ctx:CypherParser.OC_LimitContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_SortItem.
    def visitOC_SortItem(self, ctx:CypherParser.OC_SortItemContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Where.
    def visitOC_Where(self, ctx:CypherParser.OC_WhereContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Pattern.
    def visitOC_Pattern(self, ctx:CypherParser.OC_PatternContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_PatternPart.
    def visitOC_PatternPart(self, ctx:CypherParser.OC_PatternPartContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_AnonymousPatternPart.
    def visitOC_AnonymousPatternPart(self, ctx:CypherParser.OC_AnonymousPatternPartContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_PatternElement.
    def visitOC_PatternElement(self, ctx:CypherParser.OC_PatternElementContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_RelationshipsPattern.
    def visitOC_RelationshipsPattern(self, ctx:CypherParser.OC_RelationshipsPatternContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_NodePattern.
    def visitOC_NodePattern(self, ctx:CypherParser.OC_NodePatternContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_PatternElementChain.
    def visitOC_PatternElementChain(self, ctx:CypherParser.OC_PatternElementChainContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_RelationshipPattern.
    def visitOC_RelationshipPattern(self, ctx:CypherParser.OC_RelationshipPatternContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_RelationshipDetail.
    def visitOC_RelationshipDetail(self, ctx:CypherParser.OC_RelationshipDetailContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Properties.
    def visitOC_Properties(self, ctx:CypherParser.OC_PropertiesContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_RelationshipTypes.
    def visitOC_RelationshipTypes(self, ctx:CypherParser.OC_RelationshipTypesContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_NodeLabels.
    def visitOC_NodeLabels(self, ctx:CypherParser.OC_NodeLabelsContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_NodeLabel.
    def visitOC_NodeLabel(self, ctx:CypherParser.OC_NodeLabelContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_RangeLiteral.
    def visitOC_RangeLiteral(self, ctx:CypherParser.OC_RangeLiteralContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_LabelName.
    def visitOC_LabelName(self, ctx:CypherParser.OC_LabelNameContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_RelTypeName.
    def visitOC_RelTypeName(self, ctx:CypherParser.OC_RelTypeNameContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_PropertyExpression.
    def visitOC_PropertyExpression(self, ctx:CypherParser.OC_PropertyExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Expression.
    def visitOC_Expression(self, ctx:CypherParser.OC_ExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_OrExpression.
    def visitOC_OrExpression(self, ctx:CypherParser.OC_OrExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_XorExpression.
    def visitOC_XorExpression(self, ctx:CypherParser.OC_XorExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_AndExpression.
    def visitOC_AndExpression(self, ctx:CypherParser.OC_AndExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_NotExpression.
    def visitOC_NotExpression(self, ctx:CypherParser.OC_NotExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ComparisonExpression.
    def visitOC_ComparisonExpression(self, ctx:CypherParser.OC_ComparisonExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_PartialComparisonExpression.
    def visitOC_PartialComparisonExpression(self, ctx:CypherParser.OC_PartialComparisonExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_StringListNullPredicateExpression.
    def visitOC_StringListNullPredicateExpression(self, ctx:CypherParser.OC_StringListNullPredicateExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_StringPredicateExpression.
    def visitOC_StringPredicateExpression(self, ctx:CypherParser.OC_StringPredicateExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ListPredicateExpression.
    def visitOC_ListPredicateExpression(self, ctx:CypherParser.OC_ListPredicateExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_NullPredicateExpression.
    def visitOC_NullPredicateExpression(self, ctx:CypherParser.OC_NullPredicateExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_AddOrSubtractExpression.
    def visitOC_AddOrSubtractExpression(self, ctx:CypherParser.OC_AddOrSubtractExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_MultiplyDivideModuloExpression.
    def visitOC_MultiplyDivideModuloExpression(self, ctx:CypherParser.OC_MultiplyDivideModuloExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_PowerOfExpression.
    def visitOC_PowerOfExpression(self, ctx:CypherParser.OC_PowerOfExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_UnaryAddOrSubtractExpression.
    def visitOC_UnaryAddOrSubtractExpression(self, ctx:CypherParser.OC_UnaryAddOrSubtractExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_NonArithmeticOperatorExpression.
    def visitOC_NonArithmeticOperatorExpression(self, ctx:CypherParser.OC_NonArithmeticOperatorExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ListOperatorExpression.
    def visitOC_ListOperatorExpression(self, ctx:CypherParser.OC_ListOperatorExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_PropertyLookup.
    def visitOC_PropertyLookup(self, ctx:CypherParser.OC_PropertyLookupContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Atom.
    def visitOC_Atom(self, ctx:CypherParser.OC_AtomContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_CaseExpression.
    def visitOC_CaseExpression(self, ctx:CypherParser.OC_CaseExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_CaseAlternative.
    def visitOC_CaseAlternative(self, ctx:CypherParser.OC_CaseAlternativeContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ListComprehension.
    def visitOC_ListComprehension(self, ctx:CypherParser.OC_ListComprehensionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_PatternComprehension.
    def visitOC_PatternComprehension(self, ctx:CypherParser.OC_PatternComprehensionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Quantifier.
    def visitOC_Quantifier(self, ctx:CypherParser.OC_QuantifierContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_FilterExpression.
    def visitOC_FilterExpression(self, ctx:CypherParser.OC_FilterExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_PatternPredicate.
    def visitOC_PatternPredicate(self, ctx:CypherParser.OC_PatternPredicateContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ParenthesizedExpression.
    def visitOC_ParenthesizedExpression(self, ctx:CypherParser.OC_ParenthesizedExpressionContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_IdInColl.
    def visitOC_IdInColl(self, ctx:CypherParser.OC_IdInCollContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_FunctionInvocation.
    def visitOC_FunctionInvocation(self, ctx:CypherParser.OC_FunctionInvocationContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_FunctionName.
    def visitOC_FunctionName(self, ctx:CypherParser.OC_FunctionNameContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ExistentialSubquery.
    def visitOC_ExistentialSubquery(self, ctx:CypherParser.OC_ExistentialSubqueryContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ExplicitProcedureInvocation.
    def visitOC_ExplicitProcedureInvocation(self, ctx:CypherParser.OC_ExplicitProcedureInvocationContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ImplicitProcedureInvocation.
    def visitOC_ImplicitProcedureInvocation(self, ctx:CypherParser.OC_ImplicitProcedureInvocationContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ProcedureResultField.
    def visitOC_ProcedureResultField(self, ctx:CypherParser.OC_ProcedureResultFieldContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ProcedureName.
    def visitOC_ProcedureName(self, ctx:CypherParser.OC_ProcedureNameContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Namespace.
    def visitOC_Namespace(self, ctx:CypherParser.OC_NamespaceContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Variable.
    def visitOC_Variable(self, ctx:CypherParser.OC_VariableContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Literal.
    def visitOC_Literal(self, ctx:CypherParser.OC_LiteralContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_BooleanLiteral.
    def visitOC_BooleanLiteral(self, ctx:CypherParser.OC_BooleanLiteralContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_NumberLiteral.
    def visitOC_NumberLiteral(self, ctx:CypherParser.OC_NumberLiteralContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_IntegerLiteral.
    def visitOC_IntegerLiteral(self, ctx:CypherParser.OC_IntegerLiteralContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_DoubleLiteral.
    def visitOC_DoubleLiteral(self, ctx:CypherParser.OC_DoubleLiteralContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ListLiteral.
    def visitOC_ListLiteral(self, ctx:CypherParser.OC_ListLiteralContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_MapLiteral.
    def visitOC_MapLiteral(self, ctx:CypherParser.OC_MapLiteralContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_PropertyKeyName.
    def visitOC_PropertyKeyName(self, ctx:CypherParser.OC_PropertyKeyNameContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Parameter.
    def visitOC_Parameter(self, ctx:CypherParser.OC_ParameterContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_SchemaName.
    def visitOC_SchemaName(self, ctx:CypherParser.OC_SchemaNameContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_ReservedWord.
    def visitOC_ReservedWord(self, ctx:CypherParser.OC_ReservedWordContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_SymbolicName.
    def visitOC_SymbolicName(self, ctx:CypherParser.OC_SymbolicNameContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_LeftArrowHead.
    def visitOC_LeftArrowHead(self, ctx:CypherParser.OC_LeftArrowHeadContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_RightArrowHead.
    def visitOC_RightArrowHead(self, ctx:CypherParser.OC_RightArrowHeadContext):
        return self.visitChildren(ctx)


    # Visit a parse tree produced by CypherParser#oC_Dash.
    def visitOC_Dash(self, ctx:CypherParser.OC_DashContext):
        return self.visitChildren(ctx)



del CypherParser