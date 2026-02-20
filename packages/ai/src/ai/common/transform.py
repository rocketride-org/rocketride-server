from rocketlib import IEndpointBase, IGlobalBase, IInstanceBase, SERVICE_MODE, OPEN_MODE, Entry, Ec
from ai.common.config import Config


class IEndpointTransform(IEndpointBase):
    def getPipeFilters(self):
        """
        Take old style parameters and will load the driver with the proper stack to support DTC for AI.
        """
        # Use the autopipe to figure out what we need to do
        filters = ['autopipe']

        # Return the driver stack
        return filters

    def beginEndpoint(self):
        """
        Only supported in TARGET mode and FILTER mode.
        """
        if self.endpoint.serviceMode == SERVICE_MODE.SOURCE:
            raise Exception('Source mode not supported')

    def endEndpoint(self):
        pass


class IGlobalTransform(IGlobalBase):
    TRANFORM_KEY_TAG_NAME: str = ''

    def getConnConfig(self):
        """
        Parameters are in different places based on whether we are a filter or an endpoint.

        If we are a filter, they are in
        glb.connConfig, otherwise the are in IEndpoint.endpoint.parameters
        """
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.TRANSFORM:
            # Get the endpoint parameters
            parameters = self.IEndpoint.endpoint.parameters

            # If it does not have autopipe, return an empty dictionary
            if 'autopipe' not in parameters:
                return {}

            # Get the autopipe configuration
            autopipeConfig = parameters['autopipe']

            # Get the store out of it
            provider, config = Config.getMultiProviderConfig('store', autopipeConfig)
            if provider != self.glb.logicalType:
                raise Exception(f'Provider {provider} does not match {self.glb.logicalType}')

            # Return the config
            return config

        else:
            # Return the fully filled in configuration
            return Config.getNodeConfig(self.glb.logicalType, self.glb.connConfig)

    def beginGlobal(self, subKey: str):
        # Create a key like 'qdrant://host/port/collection/statue' that
        # we can use to put into the object info for transform state
        self.TRANFORM_KEY_TAG_NAME = f'{self.glb.logicalType}://{subKey.lower()}/status'.replace('\\', '/')

    def endGlobal(self):
        # Reset the transform key
        self.TRANFORM_KEY_TAG_NAME = ''


class IInstanceTransform(IInstanceBase):
    def _hasSkipped(self) -> bool:
        return self.instance.currentObject.objectSkipped

    def _hasFailed(self) -> bool:
        return self.instance.currentObject.objectFailed

    def _isEndpoint(self) -> bool:
        """
        Return True if our driver is the endpoint, False if we are only a filter driver in a larger pipe.
        """
        if self.IGlobal.glb.logicalType == self.IEndpoint.endpoint.logicalType:
            return True
        else:
            return False

    def _getTransformValue(self) -> str:
        """
        Build transform key for current object.
        """
        # Use either the change key or a combo of the modify time and size
        if self.instance.currentObject.changeKey:
            sourceKey = self.instance.currentObject.changeKey
        else:
            sourceKey = f'{self.instance.currentObject.modifyTime};{self.instance.currentObject.size}'

        # Build it
        return f'{self.instance.currentObject.flags};{sourceKey}'

    def open(self, object: Entry):
        """
        Based on the mode, this method is called to open the object.

        It checks to see if this driver is the endpoint, and if so, determine
        if we actually should open it for output. It does this by looking
        at the object information in the object.instanceTags to see if
        they match with our current info. If it does, the object does not
        need to be transformed again.

        Note: If you overide this method, you MUST call super.open() first, and then
        check if self.instance.currentObject.objectFailed is set. If it is, then the
        object will be skipped and you should exit.
        """
        # If the driver is the not the endpoint, it is a normal
        # filter, no transformation task is running
        if not self._isEndpoint():
            return

        # If it already failed, done
        if self.instance.currentObject.objectFailed:
            return

        # If we are running a transform
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.TRANSFORM:
            # If this has already failed
            if self._hasFailed():
                return

            # Get key of the last transform if any
            prevValue = self.instance.currentObject.instanceTags.get(self.IGlobal.TRANFORM_KEY_TAG_NAME, '')

            # Get current transform key
            currentValue = self._getTransformValue()

            # If the current value is the same as what we already transformed, skip it
            if prevValue == currentValue:
                self.instance.currentObject.completionCode(Ec.Skipped, 'object transformed and not changed')

        # If we are running an instance task
        elif self.IEndpoint.endpoint.openMode == OPEN_MODE.INSTANCE:
            # Nothing to do on open
            pass

        # We are done, wait for the close
        return

    def close(self):
        """
        Close the object.

        It checks the mode and handles the vectorBatchId if needed and the transformation key

        Note: If you overide this method, you MUST call super.close() first, and then
        check if self.instance.currentObject.objectFailed is set. If it is, then the
        object will be skipped and you should exit.
        """
        # If the driver is the not the endpoint, it is a normal
        # filter, no transformation task is running
        if not self._isEndpoint():
            return

        # If we are running a transform
        if self.IEndpoint.endpoint.openMode == OPEN_MODE.TRANSFORM:
            # If it failed
            if self._hasFailed():
                # And it was not due to being skipped
                if not self._hasSkipped():
                    # remove the key, we need to do it over again
                    self.instance.currentObject.instanceTags.pop(self.IGlobal.TRANFORM_KEY_TAG_NAME, None)
            else:
                # Get current transform key
                currentValue = self._getTransformValue()

                # Save the new transform key
                self.instance.currentObject.instanceTags[self.IGlobal.TRANFORM_KEY_TAG_NAME] = currentValue

        # If we are running an instance task
        elif self.IEndpoint.endpoint.openMode == OPEN_MODE.INSTANCE:
            # If the object failed
            if self._hasFailed():
                # If it is not because we skipped
                if not self._hasSkipped():
                    # IT failed, reset the batch id
                    self.entry.vectorBatchId(0)
            else:
                # It succeeded, set the batch id
                self.entry.vectorBatchId(1)

        return
