import { View } from "react-native"

function Cell({ children, style }) {
    return (
        <View
            style={[{
                paddingHorizontal: 20,
                flexDirection: 'row',
                alignItems: 'center',
                borderBottomWidth: 1,
                borderColor: '#f0f0f0',
                height: 106,
            }, style]}
        >   
        {children}  
        </View>
    )
}

export default Cell
